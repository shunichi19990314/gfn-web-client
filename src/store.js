// MVP用インメモリストア(デバイスログイン試行 + 認証セッション)
// 注意: Renderの本番運用で複数インスタンス/再起動耐性が必要になったら
//       Render Key Value (Redis) 実装へ差し替えること(インターフェースは同じに保つ)。
import { randomUUID } from 'node:crypto';

const DEVICE_ATTEMPT_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // トークン寿命(expires_in既定86400s)に合わせる
const SWEEP_INTERVAL_MS = 60 * 1000;

/** @type {Map<string, {provider: object, deviceCode: string, expiresAt: number, session: object|null}>} */
const attempts = new Map();
/** @type {Map<string, {session: object, expiresAt: number}>} */
const sessions = new Map();

let sweeper = null;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, attempt] of attempts) {
      if (attempt.expiresAt <= now) attempts.delete(id);
    }
    for (const [sid, entry] of sessions) {
      if (entry.expiresAt <= now) sessions.delete(sid);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

// ---- デバイスログイン試行 ----

export function createAttempt(provider, deviceCode, expiresInSec) {
  ensureSweeper();
  const attemptId = randomUUID();
  attempts.set(attemptId, {
    provider,
    deviceCode,
    expiresAt: Date.now() + (expiresInSec || 600) * 1000,
    session: null,
  });
  return attemptId;
}

export function getAttempt(attemptId) {
  const attempt = attempts.get(attemptId);
  if (!attempt) return null;
  if (attempt.expiresAt <= Date.now()) {
    attempts.delete(attemptId);
    return null;
  }
  return attempt;
}

export function deleteAttempt(attemptId) {
  attempts.delete(attemptId);
}

// ---- 認証セッション ----

export function saveSession(session, { ttlMs = SESSION_TTL_MS } = {}) {
  ensureSweeper();
  const sid = randomUUID();
  sessions.set(sid, { session, expiresAt: Date.now() + ttlMs });
  return sid;
}

export function getSession(sid) {
  const entry = sessions.get(sid);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return entry.session;
}

export function updateSession(sid, session) {
  const entry = sessions.get(sid);
  if (!entry) return;
  entry.session = session;
}

export function deleteSession(sid) {
  sessions.delete(sid);
  activeSessions.delete(sid);
}

// ---- アクティブなゲームセッション(CloudMatch) ----

/** @type {Map<string, object>} sid → {sessionId, controlBase, serverIp, zone, appId, keyboardLayout, info, resumePending} */
const activeSessions = new Map();

export function setActiveSession(sid, state) {
  activeSessions.set(sid, state);
}

export function getActiveSession(sid) {
  return activeSessions.get(sid) ?? null;
}

export function clearActiveSession(sid) {
  activeSessions.delete(sid);
}

export function stats() {
  return { attempts: attempts.size, sessions: sessions.size, activeSessions: activeSessions.size };
}

// ---- 簡易レート制限(IPごと・スライディングウィンドウ) ----

const buckets = new Map();

/**
 * @returns {boolean} true=許可
 */
export function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
