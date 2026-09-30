// GfnStream — Phase 2A のWebRTCストリーム受信クライアント
// OpenNOW v0.5.5 (MIT) renderer/src/platforms/gfn/webrtcClient.ts の簡約移植
// (映像受信+ハートビートまで。キー/マウス/ゲームパッド入力は Phase 2B)
import {
  buildIceLiteHostCandidate,
  extractIceCredentials,
  extractMLinePorts,
  extractNegotiatedVideoCodec,
  extractPublicIp,
  fixServerIp,
  mungeAnswerSdp,
  offerIsIceLite,
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
  #localCandidateCount = 0;
  #remoteCandidateCount = 0;
  #offerHadCandidates = true;
  #offerMLinePorts = [];
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
      this.#localCandidateCount += 1;
      if (this.#localCandidateCount <= 6) {
        this.log(`local candidate #${this.#localCandidateCount}: ${payload.candidate.slice(0, 90)}`);
      }
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
        this.#callbacks.onError?.(
          pc.iceConnectionState === 'failed'
            ? 'ICE接続の確立に失敗(サーバー候補に到達できず)。TURN未提供/NAT制限/リージョン遠隔が疑われます。診断情報を確認し、別リージョンで再試行してください'
            : `PeerConnection ${pc.connectionState}`,
        );
      }
    };
    pc.oniceconnectionstatechange = () => {
      this.log(`ICE: ${pc.iceConnectionState}`);
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
        this.#addRemoteIce(event.candidate).catch((error) => {
          this.log(`addIceCandidate FAILED: ${error?.message ?? error} (candidate: ${String(event.candidate?.candidate ?? '').slice(0, 70)})`);
        });
      } else if (event.type === 'log') {
        this.log(`signaling: ${event.message}`);
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

    // 1) サーバー候補アドレスの補正
    //   優先: mediaConnectionInfo(usage 2/17)。
    //   フォールバック: 2026年現在の応答では usage 2/17 も iceServerConfiguration も
    //   欠落することがある(実測)。その場合は session.serverIp(ダッシュ形式ホスト→IP)で
    //   0.0.0.0 候補を書き換える。怠るとICEが 0.0.0.0 宛になり永遠に接続できず、
    //   サーバーがタイムアウトでシグナリングを切断する(2026-09-29 実障害)。
    let processedOffer = offerSdp;
    // フォレンジック: 生offerの全行をログ(ICE問題の一次資料)
    {
      const lines = offerSdp.split(/\r?\n/).filter((l) => l.trim() !== '');
      this.log(`offer SDP (${lines.length} lines):`);
      for (const line of lines) this.log(`offer| ${line}`);
      const aCand = lines.filter((l) => l.startsWith('a=candidate:')).length;
      const bareCand = lines.filter((l) => /^candidate:/.test(l)).length;
      const cZero = lines.filter((l) => l.startsWith('c=IN IP4 0.0.0.0')).length;
      this.log(`offer analysis: a=candidate:${aCand} bare-candidate:${bareCand} c=0.0.0.0:${cZero} ice-lite:${offerIsIceLite(offerSdp)}`);
      this.#offerHadCandidates = aCand + bareCand > 0;
      this.#offerMLinePorts = extractMLinePorts(offerSdp);
    }
    const rewriteIp = this.#remoteIceEndpoint?.ip ?? this.#session.serverIp ?? null;
    if (rewriteIp) {
      const zeroBefore = (processedOffer.match(/0\.0\.0\.0/g) ?? []).length;
      processedOffer = fixServerIp(processedOffer, rewriteIp);
      if (this.#remoteIceEndpoint?.ip) {
        const rewritten = rewriteSdpIceCandidateEndpoints(processedOffer, this.#remoteIceEndpoint);
        if (rewritten.replacements > 0) {
          processedOffer = rewritten.sdp;
          this.log(`Rewrote ${rewritten.replacements} server ICE endpoint(s) to mediaConnectionInfo`);
        }
      } else {
        const zeroAfter = (processedOffer.match(/0\.0\.0\.0/g) ?? []).length;
        this.log(`offer 0.0.0.0 candidates: ${zeroBefore} → ${zeroAfter} (rewritten via serverIp=${extractPublicIp(rewriteIp) ?? rewriteIp})`);
      }
    } else {
      this.log('WARNING: no mediaConnectionInfo and no serverIp — cannot rewrite 0.0.0.0 candidates');
    }
    // 診断: offer の candidate 行をログ(ICEトラブルの一次情報)
    for (const line of processedOffer.split(/\r?\n/)) {
      if (line.startsWith('a=candidate:')) this.log(`offer candidate: ${line.slice(0, 110)}`);
    }

    // 2) offerからRI入力能力をパース(nvstSdpにエコーバックする)
    this.#riCapabilities = {
      ...this.#riCapabilities,
      ...parseRiInputCapabilities(offerSdp),
    };
    if (this.#riCapabilities.partialReliableThresholdMs === null) {
      this.#riCapabilities.partialReliableThresholdMs = DEFAULT_PARTIAL_RELIABLE_THRESHOLD_MS;
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: processedOffer });
    this.log('Remote description set');
    for (const queued of this.#queuedRemoteIce.splice(0)) {
      await this.#addRemoteIce(queued).catch(() => {});
    }

    // 3) H264優先 — setRemoteDescription「後」に実行すること。
    //    transceiver は offer 適用時に生成されるため、前に呼ぶと no-op になり
    //    サーバー提示順(例: AV1)で交渉されてしまう(2026-09-29 実障害)
    const h264Applied = preferH264(pc);
    this.log(`H264 codec preference applied: ${h264Applied}`);

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

    // ice-liteサーバーが候補を1つも提供しない場合(2026-09現行インフラの実測挙動)、
    // serverIp + m=行ポートからhost候補を合成して注入する。
    // これが無いとブラウザ側ICEはペアを形成できず "new" のままとなり、
    // サーバーが約16秒でシグナリングを切断する。
    if (!this.#offerHadCandidates && offerIsIceLite(processedOffer)) {
      const serverIpRaw = this.#session.serverIp ?? null;
      const serverIp = serverIpRaw ? extractPublicIp(serverIpRaw) : null;
      const ports = this.#offerMLinePorts ?? [];
      if (serverIp && ports.length > 0) {
        let injected = 0;
        for (const port of ports) {
          const candidate = buildIceLiteHostCandidate(serverIp, port, injected + 1);
          try {
            await pc.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 });
            injected += 1;
            this.#remoteCandidateCount += 1;
            this.log(`ice-lite: injected synthesized host candidate → ${serverIp}:${port}`);
          } catch (error) {
            this.log(`ice-lite: inject FAILED for ${serverIp}:${port}: ${error?.message ?? error}`);
          }
        }
        if (injected === 0) {
          this.log('ice-lite: no candidates could be injected — ICE will not connect');
        }
      } else {
        this.log(`ice-lite: cannot synthesize candidates (serverIp=${serverIpRaw} ports=${JSON.stringify(ports)})`);
      }
    }
    setTimeout(() => {
      if (this.#disposed) return;
      this.log(`post-answer check: remoteCandidates=${this.#remoteCandidateCount} localCandidates=${this.#localCandidateCount} ice=${pc.iceConnectionState} conn=${pc.connectionState}`);
      if (this.#remoteCandidateCount === 0) {
        this.log('WARNING: サーバーからICE候補が1つも届いていない — サーバーはICE-liteではなく候補trickleもしない可能性。rtsps/RTSP系トランスポート(nvst_rtsp)を要求されている疑い');
      }
    }, 8000);
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
    this.#remoteCandidateCount += 1;
    if (this.#remoteCandidateCount <= 6) {
      this.log(`remote candidate #${this.#remoteCandidateCount} added: ${String(init.candidate).slice(0, 90)}`);
    }
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
