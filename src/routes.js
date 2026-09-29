// Fastify ルート定義
// 設計書 Phase 1: 認証プロキシ(デバイスフロー)+ ライブラリ表示 + 購読情報
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = `v${JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version}-ui2`;

import { DEFAULT_STREAMING_URL, TOKEN_REFRESH_WINDOW_MS, isTrustedStreamingBase } from './config.js';
import {
  SessionConflictError,
  claimSession,
  createSession,
  mergeAdStateForPoll,
  pollSession,
  reportAd,
  resolveRequestedRegion,
  stopSession,
} from './cloudmatch.js';
import {
  deviceAuthorize,
  deviceTokenPoll,
  ensureClientToken,
  fetchLibraryPage,
  fetchProviders,
  fetchServerInfo,
  fetchSubscription,
  refreshTokens,
  resolveUser,
  sessionToken,
  validateImportedToken,
} from './nvidia.js';
import { UpstreamError } from './upstream.js';
import * as store from './store.js';

const COOKIE_NAME = 'gfnweb_sid';
const INSTANCE_ID = randomUUID(); // プロセス単位の疑似device_id(gfn.rs stable_device_id相当の代替)

function clientIp(request) {
  return request.ip ?? 'unknown';
}

function limit(request, reply, key, { max, windowMs }) {
  if (!store.rateLimit(`${key}:${clientIp(request)}`, { max, windowMs })) {
    reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    return false;
  }
  return true;
}

/** Cookieからセッションを取得。token期限が近ければリフレッシュして保存し直す */
async function requireSession(request, reply) {
  const sid = request.cookies?.[COOKIE_NAME];
  if (!sid) {
    reply.code(401).send({ error: 'authentication_required', message: 'Sign in to your NVIDIA account first.' });
    return null;
  }
  const record = store.getSession(sid);
  if (!record) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    reply.code(401).send({ error: 'authentication_required', message: 'Session expired. Sign in again.' });
    return null;
  }
  // access_token のリフレッシュ(gfn.rs:756-800相当の簡易版)
  const hasRefreshMaterial = Boolean(record.tokens.refreshToken || record.tokens.clientToken);
  if (record.tokens.expiresAt <= Date.now() && !hasRefreshMaterial) {
    // トークンインポート等、リフレッシュ手段が無いセッションは期限切れで終了
    store.deleteSession(sid);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    reply.code(401).send({ error: 'authentication_required', message: 'Token expired. Sign in again.' });
    return null;
  }
  if (hasRefreshMaterial && record.tokens.expiresAt - Date.now() < TOKEN_REFRESH_WINDOW_MS) {
    try {
      record.tokens = await refreshTokens(record.tokens, record.user.userId);
      store.updateSession(sid, record);
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'authentication_required') {
        store.deleteSession(sid);
        reply.clearCookie(COOKIE_NAME, { path: '/' });
        reply.code(401).send({ error: 'authentication_required', message: 'Session revoked. Sign in again.' });
        return null;
      }
      request.log.warn({ err: error.message }, 'token refresh deferred');
    }
  }
  return { sid, ...record };
}

/** トークン等の機微情報を除いた公開用セッション情報 */
function publicSessionView(record) {
  return {
    user: record.user,
    provider: record.provider,
    tokens: {
      expiresAt: record.tokens.expiresAt,
      hasRefreshToken: Boolean(record.tokens.refreshToken),
      hasClientToken: Boolean(record.tokens.clientToken),
    },
    imported: Boolean(record.imported),
    deviceHashId: record.deviceHashId,
  };
}

export async function registerRoutes(app) {
  // ---- 基本 ----

  app.get('/healthz', async () => ({ ok: true, version: APP_VERSION, uptime: process.uptime(), store: store.stats() }));

  // ---- 認証 ----

  app.get('/api/providers', async (request, reply) => {
    if (!limit(request, reply, 'providers', { max: 30, windowMs: 60_000 })) return;
    const providers = await fetchProviders();
    return { providers };
  });

  app.post('/api/auth/device/start', async (request, reply) => {
    if (!limit(request, reply, 'device-start', { max: 10, windowMs: 60 * 60_000 })) return;
    const { providerIdpId } = request.body ?? {};
    const providers = await fetchProviders();
    const provider =
      providers.find((p) => p.idpId === providerIdpId) ??
      providers[0] ?? {
        idpId: null,
        code: 'NVIDIA',
        displayName: 'NVIDIA',
        streamingServiceUrl: DEFAULT_STREAMING_URL,
        priority: 0,
      };
    const deviceId = randomUUID();
    const auth = await deviceAuthorize({ idpId: provider.idpId, deviceId });
    const attemptId = store.createAttempt(
      { ...provider, deviceId },
      auth.deviceCode,
      auth.expiresInSec,
    );
    const qrDataUrl = await QRCode.toDataURL(auth.verificationUriComplete, {
      margin: 1,
      width: 256,
      errorCorrectionLevel: 'M',
    });
    reply.code(201).send({
      attemptId,
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      qrDataUrl,
      expiresAt: Date.now() + auth.expiresInSec * 1000,
      intervalSeconds: auth.intervalSec,
      provider: { code: provider.code, displayName: provider.displayName },
    });
  });

  app.post('/api/auth/device/poll', async (request, reply) => {
    if (!limit(request, reply, 'device-poll', { max: 120, windowMs: 60_000 })) return;
    const { attemptId, deviceCode } = request.body ?? {};
    if (typeof attemptId !== 'string' || typeof deviceCode !== 'string') {
      return reply.code(400).send({ error: 'invalid_params', message: 'attemptId and deviceCode are required' });
    }
    const attempt = store.getAttempt(attemptId);
    if (!attempt || attempt.deviceCode !== deviceCode) {
      return { status: 'expired', error: 'QR login was cancelled or expired' };
    }
    if (attempt.session) {
      return { status: 'authorized' };
    }
    const result = await deviceTokenPoll(deviceCode);
    if (result.status !== 'authorized') {
      if (result.status === 'expired' || result.status === 'access_denied') store.deleteAttempt(attemptId);
      return result;
    }
    // 承認完了: client_token確保 → ユーザー情報確定 → attemptに保留セッションを格納
    let tokens = await ensureClientToken(result.tokens);
    const user = await resolveUser(tokens);
    attempt.session = {
      provider: attempt.provider,
      tokens,
      user: { ...user, membershipTier: 'FREE' },
      deviceHashId: randomUUID(),
    };
    return { status: 'authorized' };
  });

  app.post('/api/auth/device/complete', async (request, reply) => {
    if (!limit(request, reply, 'device-complete', { max: 30, windowMs: 60_000 })) return;
    const { attemptId, staySignedIn = true } = request.body ?? {};
    const attempt = typeof attemptId === 'string' ? store.getAttempt(attemptId) : null;
    if (!attempt?.session) {
      return reply.code(400).send({ error: 'invalid_params', message: 'QR login has not been authorized yet' });
    }
    store.deleteAttempt(attemptId);
    const sid = store.saveSession(attempt.session);
    reply.setCookie(COOKIE_NAME, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.productionCookieSecure,
      maxAge: 24 * 60 * 60,
    });
    return { session: publicSessionView(attempt.session), persisted: Boolean(staySignedIn) };
  });

  app.post('/api/auth/device/cancel', async (request) => {
    const { attemptId } = request.body ?? {};
    if (typeof attemptId === 'string') store.deleteAttempt(attemptId);
    return { ok: true };
  });

  // トークンインポート(公式 play.geforcenow.com のセッションJWTを貼り付け)
  app.post('/api/auth/token/import', async (request, reply) => {
    if (!limit(request, reply, 'token-import', { max: 10, windowMs: 60 * 60_000 })) return;
    const { token } = request.body ?? {};
    const { provider, user, expiresAt, membershipTier } = await validateImportedToken(String(token ?? ''));
    const record = {
      provider,
      tokens: {
        accessToken: String(token).trim(),
        idToken: String(token).trim(),
        refreshToken: null,
        clientToken: null,
        clientTokenExpiresAt: null,
        expiresAt,
        authClientId: null,
      },
      user: { ...user, membershipTier: membershipTier ?? 'FREE' },
      deviceHashId: randomUUID(),
      imported: true,
    };
    const ttlMs = Math.max(60_000, Math.min(expiresAt - Date.now(), 24 * 60 * 60 * 1000));
    const sid = store.saveSession(record, { ttlMs });
    reply.setCookie(COOKIE_NAME, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: app.productionCookieSecure,
      maxAge: Math.floor(ttlMs / 1000),
    });
    request.log.info({ userId: user.userId }, 'session imported via token paste');
    return { session: publicSessionView(record), imported: true };
  });

  app.get('/api/session', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return { session: publicSessionView(session) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sid = request.cookies?.[COOKIE_NAME];
    if (sid) store.deleteSession(sid);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // ---- リージョン / vpcId ----

  app.get('/api/regions', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'regions', { max: 30, windowMs: 60_000 })) return;
    const base = isTrustedStreamingBase(session.provider?.streamingServiceUrl)
      ? session.provider.streamingServiceUrl
      : DEFAULT_STREAMING_URL;
    const info = await fetchServerInfo(base, sessionToken(session.tokens));
    return { ...info, requestedBase: base };
  });

  // ---- ライブラリ ----

  app.get('/api/library', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'library', { max: 60, windowMs: 60_000 })) return;
    const cursor = typeof request.query?.cursor === 'string' ? request.query.cursor.slice(0, 4096) : '';
    const base = isTrustedStreamingBase(session.provider?.streamingServiceUrl)
      ? session.provider.streamingServiceUrl
      : DEFAULT_STREAMING_URL;
    // vpcId を serverInfo から解決(gfn.rs:1661)。失敗時は "GFN-PC" フォールバック(server_vpc_cache.rs)
    let vpcId = 'GFN-PC';
    try {
      const info = await fetchServerInfo(base, sessionToken(session.tokens));
      if (info.vpcId) vpcId = info.vpcId;
    } catch (error) {
      request.log.warn({ err: error.message }, 'serverInfo failed; falling back to GFN-PC vpcId');
    }
    const page = await fetchLibraryPage({ token: sessionToken(session.tokens), vpcId, cursor });
    return { ...page, vpcId };
  });

  // ---- 購読情報 ----

  // ---- セッション(CloudMatch) ----

  function resolveProviderBase(session) {
    return isTrustedStreamingBase(session.provider?.streamingServiceUrl)
      ? session.provider.streamingServiceUrl
      : DEFAULT_STREAMING_URL;
  }

  function requireActiveSession(sid, reply) {
    const active = store.getActiveSession(sid);
    if (!active) {
      reply.code(404).send({ error: 'no_active_session', message: 'No active GeForce NOW session' });
      return null;
    }
    return active;
  }

  app.post('/api/session/start', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'session-start', { max: 20, windowMs: 60 * 1000 })) return;
    const { appId, title, appLaunchMode, settings, region } = request.body ?? {};
    if (!/^\d+$/.test(String(appId ?? ''))) {
      return reply.code(400).send({ error: 'invalid_params', message: 'appId must be numeric (launchAppId)' });
    }
    const existing = store.getActiveSession(session.sid);
    if (existing) {
      return reply.code(409).send({
        error: 'session_conflict',
        message: 'A session is already active on this browser tab.',
        session: existing.info,
      });
    }
    const { info, base, zone, clientId } = await createSession({
      appId: String(appId),
      params: { title: typeof title === 'string' ? title : null, appLaunchMode, zone: undefined },
      settings: settings ?? {},
      token: sessionToken(session.tokens),
      deviceHashId: session.deviceHashId,
      providerBase: resolveRequestedRegion(region, resolveProviderBase(session)),
    });
    store.setActiveSession(session.sid, {
      sessionId: info.sessionId,
      controlBase: info.streamingBaseUrl,
      pollBase: base.href, // 実際に作成に成功した基(404時のフォールバック起点)
      requestedBase: base.href,
      serverIp: info.serverIp,
      zone,
      appId: String(appId),
      clientId,
      keyboardLayout: info.keyboardLayout,
      resumePending: false,
      lastSessionAds: Array.isArray(info.adState?.sessionAds) && info.adState.sessionAds.length > 0 ? info.adState.sessionAds : null,
      info,
    });
    request.log.info({ sessionId: info.sessionId, zone, status: info.status }, 'CloudMatch session created');
    reply.code(201).send({ session: info });
  });

  app.get('/api/session/poll', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const active = requireActiveSession(session.sid, reply);
    if (!active) return;
    if (!limit(request, reply, 'session-poll', { max: 300, windowMs: 60_000 })) return;
    let info;
    let effectiveBase = null;
    try {
      ({ info, effectiveBase } = await pollSession({
        state: active,
        token: sessionToken(session.tokens),
        deviceHashId: session.deviceHashId,
      }));
    } catch (error) {
      // 全候補基で404(INVALID_SESSION_ID_NOT_FOUND)= サーバー側でセッション消滅。
      // ローカルのアクティブ状態を解放しないと、以降の起動が409競合ループに陥る
      if (error?.status === 404) {
        store.clearActiveSession(session.sid);
        request.log.warn({ sessionId: active.sessionId }, 'session gone upstream; cleared local state');
        return reply.code(410).send({
          error: 'session_gone',
          message: 'このセッションはサーバー側で失効しています。ライブラリに戻って起動し直してください。',
          sessionId: active.sessionId,
        });
      }
      throw error;
    }
    // 広告リストは作成直後のpollでしか届かないため、active state に保持して引き継ぐ
    active.lastSessionAds = mergeAdStateForPoll(active.lastSessionAds ?? null, info);
    active.info = info;
    active.controlBase = info.streamingBaseUrl;
    active.serverIp = info.serverIp;
    active.resumePending = info.resumePending === true;
    if (effectiveBase) active.pollBase = effectiveBase; // 成功した基を次回以降の第一候補に
    store.setActiveSession(session.sid, active);
    return { session: info };
  });

  app.get('/api/session/active', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return { session: store.getActiveSession(session.sid)?.info ?? null };
  });

  app.post('/api/session/stop', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const active = store.getActiveSession(session.sid);
    if (!active) return { session: null, stopped: false };
    let result = { stopped: false };
    let upstreamError = null;
    try {
      result = await stopSession({
        state: active,
        token: sessionToken(session.tokens),
        deviceHashId: session.deviceHashId,
      });
    } catch (error) {
      // 上流で停止できなくても、ローカル状態は必ず解放する(ゾンビ競合の防止)
      upstreamError = error.message;
    }
    store.clearActiveSession(session.sid);
    request.log.info({ sessionId: active.sessionId, stopped: result.stopped }, 'CloudMatch session stopped');
    return { session: null, stopped: result.stopped, sessionId: active.sessionId, upstreamError };
  });

  app.post('/api/session/ad', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const active = requireActiveSession(session.sid, reply);
    if (!active) return;
    const info = await reportAd({
      state: active,
      params: request.body ?? {},
      token: sessionToken(session.tokens),
      deviceHashId: session.deviceHashId,
    });
    active.lastSessionAds = mergeAdStateForPoll(active.lastSessionAds ?? null, info);
    active.info = info;
    active.controlBase = info.streamingBaseUrl;
    active.serverIp = info.serverIp;
    store.setActiveSession(session.sid, active);
    return { session: info };
  });

  // 別デバイス/中断中のセッションを引き継ぐ(RESUME)
  app.post('/api/session/claim', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'session-claim', { max: 20, windowMs: 60_000 })) return;
    const { sessionId, serverIp, streamingBaseUrl, settings } = request.body ?? {};
    if (typeof sessionId !== 'string' || sessionId === '') {
      return reply.code(400).send({ error: 'invalid_params', message: 'sessionId is required' });
    }
    const { info, controlBase } = await claimSession({
      sessionId,
      state: serverIp || streamingBaseUrl
        ? { sessionId, serverIp: serverIp ?? null, controlBase: streamingBaseUrl ?? null }
        : store.getActiveSession(session.sid),
      settings: settings ?? {},
      token: sessionToken(session.tokens),
      deviceHashId: session.deviceHashId,
      providerBase: resolveProviderBase(session),
    });
    store.setActiveSession(session.sid, {
      sessionId: info.sessionId,
      controlBase: info.streamingBaseUrl ?? controlBase.href,
      pollBase: controlBase.href,
      requestedBase: resolveProviderBase(session),
      serverIp: info.serverIp,
      zone: info.zone,
      appId: info.appId,
      clientId: info.clientId ?? null,
      keyboardLayout: info.keyboardLayout,
      resumePending: true,
      info,
    });
    request.log.info({ sessionId: info.sessionId }, 'CloudMatch session claimed (RESUME)');
    return { session: info };
  });

  // 別デバイスで発生中のセッション(競合)を停止する
  app.post('/api/session/remote/stop', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'session-remote-stop', { max: 10, windowMs: 60_000 })) return;
    const { sessionId, serverIp, streamingBaseUrl } = request.body ?? {};
    if (typeof sessionId !== 'string' || sessionId === '') {
      return reply.code(400).send({ error: 'invalid_params', message: 'sessionId is required' });
    }
    const result = await stopSession({
      state: { sessionId, serverIp: serverIp ?? null, controlBase: streamingBaseUrl ?? null },
      token: sessionToken(session.tokens),
      deviceHashId: session.deviceHashId,
    });
    return { stopped: result.stopped, sessionId };
  });

  app.get('/api/subscription', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!limit(request, reply, 'subscription', { max: 30, windowMs: 60_000 })) return;
    const base = isTrustedStreamingBase(session.provider?.streamingServiceUrl)
      ? session.provider.streamingServiceUrl
      : DEFAULT_STREAMING_URL;
    let vpcId = 'GFN-PC';
    try {
      const info = await fetchServerInfo(base, sessionToken(session.tokens));
      if (info.vpcId) vpcId = info.vpcId;
    } catch {
      /* フォールバック使用 */
    }
    const subscription = await fetchSubscription({
      token: sessionToken(session.tokens),
      vpcId,
      userId: session.user.userId,
    });
    // membershipTier をセッション側にも反映(表示用)
    session.user.membershipTier = subscription.membershipTier;
    store.updateSession(session.sid, session);
    return { subscription, vpcId };
  });
}

/** UpstreamError → HTTPステータス変換(グローバルエラーハンドラ) */
export function upstreamErrorHandler(error, request, reply) {
  if (error instanceof SessionConflictError) {
    request.log.info({ sessions: error.sessions?.length ?? 0 }, 'session conflict detected');
    return reply.code(409).send({
      error: 'session_conflict',
      message: error.message,
      sessions: error.sessions ?? [],
    });
  }
  if (error instanceof UpstreamError) {
    const status =
      error.code === 'authentication_required'
        ? 401
        : error.code === 'invalid_params'
          ? 400
          : error.code === 'session_error'
            ? 502
            : 502;
    request.log.warn({ code: error.code, kind: error.kind, message: error.message }, 'upstream error');
    return reply.code(status).send({ error: error.code, kind: error.kind ?? undefined, message: error.message });
  }
  if (error?.statusCode === 429) {
    return reply.code(429).send({ error: 'rate_limited', message: error.message });
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
}

// テスト用エクスポート
export const __test__ = { publicSessionView, INSTANCE_ID };
