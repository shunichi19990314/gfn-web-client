// NVSTシグナリング WebSocketリレー
// ブラウザは自サイト-originの /ws/signaling に接続し、このリレーが
// wss://{serverIp}:443/nvst/sign_in へOrigin/User-Agent/サブプロトコルを
// 詐称…ではなく「公式Webクライアント相当のヘッダ」を付与して中継する。
// (ブラウザのWebSocket APIではカスタムヘッダを設定できないためのサーバー側リレー)
//
// プロトコル中継は透過(ダミーリレー)。peer_info/hb/ack/peer_msg の
// プロトコル処理はすべてブラウザ側 public/js/signaling.js が行う。
// 出典: OpenNOW v0.5.5 opennow-stable/src/main/platforms/gfn/signaling.ts
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import { GFN_USER_AGENT } from './config.js';

const COOKIE_NAME = 'gfnweb_sid';
const UPSTREAM_PING_INTERVAL_MS = 25_000;
const PRE_OPEN_QUEUE_LIMIT = 64;

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

/** wss://{server}/nvst/ → wss://{server}/nvst/sign_in?peer_id=…&version=2&peer_role=1&pairing_id={sessionId} */
export function buildSignInUrl(signalingUrl, sessionId) {
  const base = new URL(signalingUrl);
  base.protocol = 'wss:';
  base.pathname = `${base.pathname.replace(/\/?$/, '/')}sign_in`;
  base.search = '';
  const peerName = `peer-${Math.floor(Math.random() * 10_000_000_000)}`;
  base.searchParams.set('peer_id', peerName);
  base.searchParams.set('version', '2');
  base.searchParams.set('peer_role', '1');
  base.searchParams.set('pairing_id', sessionId);
  return { url: base.toString(), peerName };
}

/**
 * Fastifyアプリの生HTTPサーバーにupgradeハンドラを登録する
 * @param {object} options { app, getSession(sid), getActiveSession(sid), log }
 */
export function attachSignalingRelay({ app, getSession, getActiveSession, log = console }) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/signaling') {
      socket.destroy();
      return;
    }
    // 認証: Cookieのセッション + アクティブなCloudMatchセッションが必要
    const sid = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const record = sid ? getSession(sid) : null;
    const active = sid ? getActiveSession(sid) : null;
    if (!record || !active?.info?.signalingUrl || !active?.sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const requestedSessionId = url.searchParams.get('sessionId');
    if (requestedSessionId && requestedSessionId !== active.sessionId) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      relay(clientWs, active, log).catch((error) => {
        log.error?.({ err: error?.message }, 'signaling relay failed');
        try { clientWs.close(1011, 'relay failure'); } catch { /* ignore */ }
      });
    });
  });

  return wss;
}

async function relay(clientWs, active, log) {
  const { url: signInUrl, peerName } = buildSignInUrl(active.info.signalingUrl, active.sessionId);
  const subprotocol = `x-nv-sessionid.${active.sessionId}`;

  const upstream = new NodeWebSocket(signInUrl, [subprotocol], {
    headers: {
      Origin: 'https://play.geforcenow.com',
      'User-Agent': GFN_USER_AGENT,
    },
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });

  const queue = [];
  let upstreamOpen = false;
  let closed = false;
  const pingTimer = setInterval(() => {
    if (upstreamOpen && upstream.readyState === NodeWebSocket.OPEN) {
      try { upstream.ping(); } catch { /* ignore */ }
    }
  }, UPSTREAM_PING_INTERVAL_MS);
  pingTimer.unref?.();

  const closeAll = (code, reason) => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    try { clientWs.close(code ?? 1000, reason); } catch { /* ignore */ }
    try { upstream.close(code ?? 1000, reason); } catch { /* ignore */ }
  };

  await new Promise((resolve, reject) => {
    upstream.once('open', resolve);
    upstream.once('error', reject);
    upstream.once('unexpected-response', (_req, res) => {
      reject(new Error(`signaling upstream rejected handshake: HTTP ${res.statusCode}`));
    });
    clientWs.once('close', () => reject(new Error('client closed before upstream open')));
  }).then(() => {
    upstreamOpen = true;
    log.info?.({ sessionId: active.sessionId, peerName }, 'NVST signaling relay established');
    // クライアントからの先行メッセージをフラッシュ
    for (const data of queue.splice(0)) {
      try { upstream.send(data); } catch { /* ignore */ }
    }
  }).catch((error) => {
    closeAll(1011, 'upstream connect failed');
    throw error;
  });

  // ブラウザ → NVIDIA(透過)
  clientWs.on('message', (data, isBinary) => {
    if (!upstreamOpen) {
      if (queue.length < PRE_OPEN_QUEUE_LIMIT) queue.push(data);
      return;
    }
    if (upstream.readyState === NodeWebSocket.OPEN) {
      try { upstream.send(data, { binary: isBinary }); } catch { closeAll(1011, 'upstream send failed'); }
    }
  });
  clientWs.on('close', () => closeAll());
  clientWs.on('error', () => closeAll());

  // NVIDIA → ブラウザ(透過)
  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === clientWs.OPEN) {
      try { clientWs.send(data, { binary: isBinary }); } catch { closeAll(1011, 'client send failed'); }
    }
  });
  upstream.on('close', (code, reason) => {
    log.info?.({ sessionId: active.sessionId, code }, 'NVST signaling upstream closed');
    closeAll(1000, reason?.toString?.() || 'upstream closed');
  });
  upstream.on('error', (error) => {
    log.warn?.({ err: error?.message }, 'NVST signaling upstream error');
    closeAll(1011, 'upstream error');
  });
}
