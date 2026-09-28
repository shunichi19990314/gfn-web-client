// GfnStream — Phase 2A のWebRTCストリーム受信クライアント
// OpenNOW v0.5.5 (MIT) renderer/src/platforms/gfn/webrtcClient.ts の簡約移植
// (映像受信+ハートビートまで。キー/マウス/ゲームパッド入力は Phase 2B)
import {
  extractIceCredentials,
  extractNegotiatedVideoCodec,
  fixServerIp,
  mungeAnswerSdp,
  parseRiInputCapabilities,
  preferH264,
  rewriteSdpIceCandidateEndpoints,
} from './sdpUtils.js';
import { buildNvstSdp } from './nvstSdp.js';

const INPUT_HEARTBEAT = 2; // packetEncoding.ts — 生u32 LE(v3ラッパーなし)
const HEARTBEAT_INTERVAL_MS = 2000;
const DEFAULT_PARTIAL_RELIABLE_THRESHOLD_MS = 300;
const STATS_INTERVAL_MS = 1000;

export class GfnStream {
  #pc = null;
  #signaling = null;
  #videoEl;
  #settings;
  #session;
  #callbacks;
  #reliableInputChannel = null;
  #partiallyReliableInputChannel = null;
  #heartbeatTimer = null;
  #statsTimer = null;
  #answerSent = false;
  #queuedIce = [];
  #queuedRemoteIce = [];
  #fallbackStream = null;
  #remoteIceEndpoint = null;
  #riCapabilities = {
    partialReliableThresholdMs: DEFAULT_PARTIAL_RELIABLE_THRESHOLD_MS,
    hidDeviceMask: 0xffffffff,
    enablePartiallyReliableTransferGamepad: 15,
    enablePartiallyReliableTransferHid: 0xffffffff,
  };
  #stats = { phase: 'idle', connectionState: 'new', codec: null, rttMs: null, bitrateKbps: null, fps: null, resolution: null };
  #lastBytesReceived = 0;
  #lastStatsTs = 0;
  #disposed = false;

  /**
   * @param {object} options
   *   videoEl, session(CloudMatchのsession info), settings{resolution,fps,maxBitrateKbps,colorQuality},
   *   signaling(NvstSignalingClient), callbacks{onState,onStats,onError,onLog}
   */
  constructor({ videoEl, session, settings, signaling, callbacks = {} }) {
    this.#videoEl = videoEl;
    this.#session = session;
    this.#settings = { maxBitrateKbps: 40000, colorQuality: '8bit_420', ...settings };
    this.#signaling = signaling;
    this.#callbacks = callbacks;
    this.#remoteIceEndpoint =
      session.mediaConnectionInfo?.usage === 2 || session.mediaConnectionInfo?.usage === 17
        ? session.mediaConnectionInfo
        : null;
  }

  log(message) {
    this.#callbacks.onLog?.(message);
  }

  #setStats(patch) {
    this.#stats = { ...this.#stats, ...patch };
    this.#callbacks.onStats?.(this.#stats);
  }

  /** PeerConnection生成 + シグナリング接続。offer受信でhandleOfferが走る */
  async start() {
    const iceServers = (this.#session.iceServers ?? []).map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential,
    }));
    this.log(`ICE servers: ${iceServers.length}`);
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.#pc = pc;

    this.#createDataChannels(pc);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const payload = event.candidate.toJSON();
      if (!payload.candidate) return;
      const candidate = {
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
        usernameFragment: payload.usernameFragment,
      };
      if (!this.#answerSent) {
        this.#queuedIce.push(candidate);
        return;
      }
      this.#signaling.sendIceCandidate(candidate);
    };

    pc.onconnectionstatechange = () => {
      this.#setStats({ connectionState: pc.connectionState });
      this.#callbacks.onState?.(pc.connectionState);
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !this.#disposed) {
        this.#callbacks.onError?.(`PeerConnection ${pc.connectionState}`);
      }
    };

    pc.ontrack = (event) => {
      this.log(`Track received: ${event.track.kind}`);
      let stream = event.streams?.[0];
      if (!stream) {
        // サーバーがストリームIDを送らない場合のフォールバック
        if (!this.#fallbackStream) this.#fallbackStream = new MediaStream();
        this.#fallbackStream.addTrack(event.track);
        stream = this.#fallbackStream;
      }
      if (this.#videoEl.srcObject !== stream) {
        this.#videoEl.srcObject = stream;
      }
      this.#videoEl.play?.().catch(() => {});
      this.#setStats({ phase: 'media' });
    };

    // シグナリングイベント
    this.#signaling.onEvent((event) => {
      if (event.type === 'offer') {
        this.handleOffer(event.sdp).catch((error) => {
          this.#callbacks.onError?.(`offer処理失敗: ${error.message}`);
        });
      } else if (event.type === 'remote-ice') {
        this.#addRemoteIce(event.candidate).catch(() => {});
      } else if (event.type === 'disconnected') {
        this.#callbacks.onError?.(`シグナリング切断: ${event.reason}`);
      } else if (event.type === 'connected') {
        this.#setStats({ phase: 'signaling' });
      }
    });
    await this.#signaling.connect();
    this.#startStatsPolling();
    this.#setStats({ phase: 'waiting-offer' });
  }

  #createDataChannels(pc) {
    // 統計チャネル(サーバー→クライアント、非順序・再送なし)
    const statsChannel = pc.createDataChannel('stats_channel', { ordered: false, maxRetransmits: 0 });
    statsChannel.binaryType = 'arraybuffer';

    // 信頼入力チャネル(Phase 2Bでキー等を送る。2Aではハートビートのみ)
    this.#reliableInputChannel = pc.createDataChannel('input_channel_v1', { ordered: true });
    this.#reliableInputChannel.binaryType = 'arraybuffer';
    this.#reliableInputChannel.onopen = () => {
      this.log('Reliable input channel open');
      this.#startHeartbeat();
    };

    // 部分信頼入力チャネル(マウス相対移動用・Phase 2B)
    this.#partiallyReliableInputChannel = pc.createDataChannel('input_channel_partially_reliable', {
      ordered: false,
      maxPacketLifeTime: this.#riCapabilities.partialReliableThresholdMs,
    });
    this.#partiallyReliableInputChannel.binaryType = 'arraybuffer';
  }

  #startHeartbeat() {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#reliableInputChannel?.readyState !== 'open') return;
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, INPUT_HEARTBEAT, true); // u32 LE = 2, ラッパーなし
      this.#reliableInputChannel.send(bytes);
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** サーバーofferの処理 — webrtcClient.ts:1976-2320 の簡約版 */
  async handleOffer(offerSdp) {
    const pc = this.#pc;
    if (!pc) throw new Error('PeerConnection not initialized');
    this.log(`OFFER received (${offerSdp.length} chars)`);
    this.#setStats({ phase: 'offer' });

    // 1) CloudMatchのWebRTCメディアエンドポイント(usage 2/17)で候補アドレスを補正(公式準拠)
    let processedOffer = offerSdp;
    if (this.#remoteIceEndpoint?.ip) {
      processedOffer = fixServerIp(processedOffer, this.#remoteIceEndpoint.ip);
      const rewritten = rewriteSdpIceCandidateEndpoints(processedOffer, this.#remoteIceEndpoint);
      if (rewritten.replacements > 0) {
        processedOffer = rewritten.sdp;
        this.log(`Rewrote ${rewritten.replacements} server ICE endpoint(s) to mediaConnectionInfo`);
      }
    }

    // 2) offerからRI入力能力をパース(nvstSdpにエコーバックする)
    this.#riCapabilities = {
      ...this.#riCapabilities,
      ...parseRiInputCapabilities(offerSdp),
    };
    if (this.#riCapabilities.partialReliableThresholdMs === null) {
      this.#riCapabilities.partialReliableThresholdMs = DEFAULT_PARTIAL_RELIABLE_THRESHOLD_MS;
    }

    // 3) H264優先(2A。HEVC/AV1は Phase 2B の設定UIで)
    preferH264(pc);

    await pc.setRemoteDescription({ type: 'offer', sdp: processedOffer });
    this.log('Remote description set');
    for (const queued of this.#queuedRemoteIce.splice(0)) {
      await this.#addRemoteIce(queued).catch(() => {});
    }

    const answer = await pc.createAnswer();
    answer.sdp = mungeAnswerSdp(answer.sdp, this.#settings.maxBitrateKbps);
    await pc.setLocalDescription(answer);
    this.log('Local description set; sending answer before ICE gathering completes');

    const finalSdp = pc.localDescription?.sdp ?? answer.sdp;
    if (!finalSdp) throw new Error('Missing local SDP after setLocalDescription');
    const negotiatedCodec = extractNegotiatedVideoCodec(finalSdp) ?? 'H264';
    this.#setStats({ codec: negotiatedCodec, phase: 'answer-sent' });

    // answer送信前に溜めたICE候補をフラッシュ
    for (const candidate of this.#queuedIce.splice(0)) {
      this.#signaling.sendIceCandidate(candidate);
    }
    this.#answerSent = true;

    const credentials = extractIceCredentials(finalSdp);
    const [width, height] = String(this.#settings.resolution ?? '1920x1080').split('x').map(Number);
    const nvstSdp = buildNvstSdp({
      width: Number.isFinite(width) ? width : 1920,
      height: Number.isFinite(height) ? height : 1080,
      fps: Number(this.#settings.fps ?? 60),
      maxBitrateKbps: Number(this.#settings.maxBitrateKbps ?? 40000),
      partialReliableThresholdMs: this.#riCapabilities.partialReliableThresholdMs,
      hidDeviceMask: this.#riCapabilities.hidDeviceMask,
      enablePartiallyReliableTransferGamepad: this.#riCapabilities.enablePartiallyReliableTransferGamepad,
      enablePartiallyReliableTransferHid: this.#riCapabilities.enablePartiallyReliableTransferHid,
      codec: negotiatedCodec,
      colorQuality: this.#settings.colorQuality ?? '8bit_420',
      credentials,
      dynamicSplitEncodeUpdatesEnabled: true,
    });
    this.#signaling.sendAnswer({ sdp: finalSdp, nvstSdp });
    this.log(`Sent SDP answer + nvstSdp (codec=${negotiatedCodec})`);
  }

  async #addRemoteIce(candidate) {
    const pc = this.#pc;
    if (!pc || !pc.remoteDescription) {
      this.#queuedRemoteIce.push(candidate); // リモート候補はoffer確定まで保留
      return;
    }
    let init = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? (candidate.sdpMid == null ? 0 : undefined),
      usernameFragment: candidate.usernameFragment ?? undefined,
    };
    if (init.candidate && this.#remoteIceEndpoint) {
      const match = init.candidate.match(
        /^(a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+|candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+)(\s+)(\d+)(?=\s|$)/,
      );
      if (match) {
        init = {
          ...init,
          candidate: init.candidate.replace(
            match[0],
            `${match[1]}${this.#remoteIceEndpoint.ip}${match[3]}${this.#remoteIceEndpoint.port}`,
          ),
        };
      }
    }
    await pc.addIceCandidate(init);
  }

  #startStatsPolling() {
    if (this.#statsTimer) return;
    this.#statsTimer = setInterval(async () => {
      const pc = this.#pc;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let rttMs = null;
        let bytesReceived = null;
        let framesPerSecond = null;
        let timestamp = 0;
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) {
            bytesReceived = report.bytesReceived ?? null;
            framesPerSecond = report.framesPerSecond ?? null;
            timestamp = report.timestamp;
          }
        });
        let bitrateKbps = this.#stats.bitrateKbps;
        if (bytesReceived !== null && this.#lastStatsTs > 0 && timestamp > this.#lastStatsTs) {
          const deltaBits = (bytesReceived - this.#lastBytesReceived) * 8;
          bitrateKbps = Math.round(deltaBits / (timestamp - this.#lastStatsTs));
        }
        if (bytesReceived !== null) {
          this.#lastBytesReceived = bytesReceived;
          this.#lastStatsTs = timestamp;
        }
        const resolution = this.#videoEl.videoWidth
          ? `${this.#videoEl.videoWidth}x${this.#videoEl.videoHeight}`
          : this.#stats.resolution;
        this.#setStats({ rttMs, bitrateKbps, fps: framesPerSecond, resolution });
      } catch {
        /* stats取得失敗は無視 */
      }
    }, STATS_INTERVAL_MS);
  }

  dispose() {
    this.#disposed = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#statsTimer) clearInterval(this.#statsTimer);
    this.#heartbeatTimer = null;
    this.#statsTimer = null;
    try { this.#signaling?.disconnect(); } catch { /* ignore */ }
    try {
      for (const sender of this.#pc?.getSenders?.() ?? []) sender.track?.stop?.();
      this.#pc?.close();
    } catch { /* ignore */ }
    this.#pc = null;
    if (this.#videoEl) this.#videoEl.srcObject = null;
  }
}
