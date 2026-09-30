// NVSTシグナリングクライアント(ブラウザ側)
// OpenNOW v0.5.5 (MIT) main/platforms/gfn/signaling.ts の移植。
// 違い: 接続先が自サイトのリレーWS(/ws/signaling)。リレー先で
// Origin/UA/サブプロトコルを公式相当ヘッダに差し替えて NVIDIA の
// wss://{serverIp}/nvst/sign_in へ中継される。
// プロトコル: JSON { ackid | ack | hb | peer_info | peer_msg{from,to,msg} | error }

export class NvstSignalingClient {
  #ws = null;
  #peerId = 0;
  #remotePeerId = 1;
  #peerName = `peer-${Math.floor(Math.random() * 10_000_000_000)}`;
  #ackCounter = 0;
  #heartbeatTimer = null;
  #listeners = new Set();
  #resolution = '1920x1080';
  #sessionId;
  #ackCount = 0;

  constructor(sessionId, { resolution } = {}) {
    this.#sessionId = sessionId;
    if (resolution) this.#resolution = resolution;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* リスナーエラーは無視 */ }
    }
  }

  #nextAckId() {
    this.#ackCounter += 1;
    return this.#ackCounter;
  }

  #sendJson(payload) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(payload));
    }
  }

  #setupHeartbeat() {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => this.#sendJson({ hb: 1 }), 5000);
  }

  #clearHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #sendPeerInfo() {
    this.#sendJson({
      ackid: this.#nextAckId(),
      peer_info: {
        browser: 'Chrome',
        browserVersion: '131',
        connected: true,
        id: this.#peerId,
        name: this.#peerName,
        peerRole: 0,
        resolution: this.#resolution,
        version: 2,
      },
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws/signaling?sessionId=${encodeURIComponent(this.#sessionId)}`;
      const ws = new WebSocket(url);
      this.#ws = ws;
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        this.#sendPeerInfo();
        this.#setupHeartbeat();
        this.#emit({ type: 'connected' });
        resolve();
      });
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('Signaling relay connection failed'));
        this.#emit({ type: 'error', message: 'signaling websocket error' });
      });
      ws.addEventListener('close', (event) => {
        this.#clearHeartbeat();
        this.#ws = null;
        if (!opened) {
          reject(new Error(`Signaling relay closed: ${event.code} ${event.reason || ''}`));
          return;
        }
        this.#emit({ type: 'disconnected', reason: event.reason || `code ${event.code}` });
      });
      ws.addEventListener('message', (event) => this.#handleMessage(typeof event.data === 'string' ? event.data : ''));
    });
  }

  #handleMessage(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // 非JSONパケットは無視
    }
    if (parsed.peer_info) {
      if (typeof parsed.peer_info.id === 'number' && parsed.peer_info.name === this.#peerName) {
        this.#peerId = parsed.peer_info.id;
      }
    }
    if (typeof parsed.ackid === 'number') {
      const shouldAck = parsed.peer_info?.id !== this.#peerId;
      if (shouldAck) this.#sendJson({ ack: parsed.ackid });
    }
    if (typeof parsed.ack === 'number') {
      this.#ackCount += 1;
      if (this.#ackCount <= 5) {
        this.#emit({ type: 'log', message: `server ack #${parsed.ack} (total ${this.#ackCount})` });
      }
    }
    if (parsed.hb) {
      this.#sendJson({ hb: 1 });
      return;
    }
    if (parsed.error === 'peerRemoved') {
      this.#emit({ type: 'disconnected', reason: 'peerRemoved' });
      return;
    }
    if (!parsed.peer_msg?.msg) return;
    if (typeof parsed.peer_msg.from === 'number') {
      this.#remotePeerId = parsed.peer_msg.from;
    }
    const peerMessage = String(parsed.peer_msg.msg).trim();
    if (peerMessage === 'BYE') {
      this.#emit({ type: 'disconnected', reason: 'BYE' });
      return;
    }
    let peerPayload;
    try {
      peerPayload = JSON.parse(peerMessage);
    } catch {
      this.#emit({ type: 'log', message: `peer_msg non-JSON: ${peerMessage.slice(0, 80)}` });
      return;
    }
    this.#emit({
      type: 'log',
      message: `peer_msg received: ${peerPayload.type ?? (typeof peerPayload.candidate === 'string' ? 'candidate' : `keys=${Object.keys(peerPayload).join(',')}`)}`,
    });
    if (peerPayload.type === 'offer' && typeof peerPayload.sdp === 'string') {
      this.#emit({ type: 'offer', sdp: peerPayload.sdp });
      return;
    }
    if (typeof peerPayload.candidate === 'string') {
      this.#emit({
        type: 'remote-ice',
        candidate: {
          candidate: peerPayload.candidate,
          sdpMid: typeof peerPayload.sdpMid === 'string' || peerPayload.sdpMid === null ? peerPayload.sdpMid : undefined,
          sdpMLineIndex:
            typeof peerPayload.sdpMLineIndex === 'number' || peerPayload.sdpMLineIndex === null
              ? peerPayload.sdpMLineIndex
              : 0,
          usernameFragment:
            typeof peerPayload.usernameFragment === 'string' || peerPayload.usernameFragment === null
              ? peerPayload.usernameFragment
              : undefined,
        },
      });
    }
  }

  sendAnswer({ sdp, nvstSdp }) {
    this.#sendJson({
      peer_msg: {
        from: this.#peerId,
        to: this.#remotePeerId,
        msg: JSON.stringify({ type: 'answer', sdp, ...(nvstSdp ? { nvstSdp } : {}) }),
      },
      ackid: this.#nextAckId(),
    });
  }

  sendIceCandidate(candidate) {
    if (isTcpIceCandidate(candidate.candidate)) return; // TCP候補は破棄(公式同様)
    this.#sendJson({
      peer_msg: {
        from: this.#peerId,
        to: this.#remotePeerId,
        msg: JSON.stringify({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        }),
      },
      ackid: this.#nextAckId(),
    });
  }

  requestKeyframe(reason = 'decode_stall', backlogFrames = 0, attempt = 0) {
    this.#sendJson({
      peer_msg: {
        from: this.#peerId,
        to: this.#remotePeerId,
        msg: JSON.stringify({ type: 'request_keyframe', reason, backlogFrames, attempt }),
      },
      ackid: this.#nextAckId(),
    });
  }

  disconnect() {
    this.#clearHeartbeat();
    if (this.#ws) {
      const socket = this.#ws;
      this.#ws = null;
      socket.close();
    }
  }
}

function isTcpIceCandidate(candidate) {
  const parts = String(candidate).trim().split(/\s+/);
  return parts[2]?.toLowerCase() === 'tcp';
}
