// /api/session/stop ルートの統合テスト(app.inject + ストア直接投入 + fetchモック)
// 実障害: 「セッション停止: Internal server error」(500) の再現と回帰防止
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/server.js';
import * as store from '../src/store.js';

function mockFetch(t, handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = realFetch; });
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(payload) };
}

function seedSession() {
  return store.saveSession({
    provider: { idpId: 'x', code: 'NVIDIA', displayName: 'NVIDIA', streamingServiceUrl: 'https://prod.cloudmatchbeta.nvidiagrid.net/', priority: 0 },
    tokens: {
      accessToken: 'at', idToken: 'it', refreshToken: null, clientToken: null,
      expiresAt: Date.now() + 60 * 60 * 1000, authClientId: 'cid',
    },
    user: { userId: 'u1', displayName: 'tester', email: null, avatarUrl: null, membershipTier: 'FREE' },
    deviceHashId: 'dev-1',
  });
}

test('stop: 上流DELETEが503(QUEUE_ABANDONED後の停止)でも 200 を返し状態を解放', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  store.setActiveSession(sid, {
    sessionId: 'dead-1',
    controlBase: 'https://np-ams-07.cloudmatchbeta.nvidiagrid.net',
    pollBase: 'https://np-ams-07.cloudmatchbeta.nvidiagrid.net/',
    serverIp: 'np-ams-07.cloudmatchbeta.nvidiagrid.net',
    zone: 'eu-netherlands-north.cloudmatchbeta.nvidiagrid.net',
    appId: '1',
    info: { sessionId: 'dead-1' },
  });
  mockFetch(t, async () => jsonResponse({ requestStatus: { statusCode: 69, statusDescription: 'SESSION_REQUEST_IN_QUEUE_ABANDONED 4A8C300F' } }, 503));

  const res = await app.inject({
    method: 'POST',
    url: '/api/session/stop',
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  const body = res.json();
  assert.equal(body.stopped, false);
  assert.ok(body.upstreamError, 'upstreamError にメッセージが入る');
  assert.equal(store.getActiveSession(sid), null, 'ローカル状態は必ず解放される');
});

test('stop: 上流DELETEが200 → stopped:true', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  store.setActiveSession(sid, {
    sessionId: 'live-1',
    controlBase: 'https://np-ams-07.cloudmatchbeta.nvidiagrid.net',
    serverIp: null,
    zone: 'z',
    appId: '1',
    info: {},
  });
  mockFetch(t, async () => jsonResponse({ requestStatus: { statusCode: 1 } }, 200));
  const res = await app.inject({ method: 'POST', url: '/api/session/stop', cookies: { gfnweb_sid: sid } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stopped, true);
});

test('stop: アクティブセッションなし → 200 {stopped:false}(404/500にしない)', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  const res = await app.inject({ method: 'POST', url: '/api/session/stop', cookies: { gfnweb_sid: sid } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stopped, false);
});

test('stop: tokens欠損の壊れたレコードでも500にならない(401で再ログイン誘導)', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  // tokens を欠いた壊れたセッションレコードを直接投入
  const sid = store.saveSession({ provider: {}, user: { userId: 'u' }, deviceHashId: 'd' });
  const res = await app.inject({ method: 'POST', url: '/api/session/stop', cookies: { gfnweb_sid: sid } });
  assert.notEqual(res.statusCode, 500, `must not 500, got ${res.statusCode}: ${res.body}`);
});

test('poll: tokens欠損でも500にならない', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = store.saveSession({ provider: {}, user: { userId: 'u' }, deviceHashId: 'd' });
  store.setActiveSession(sid, { sessionId: 's', controlBase: 'https://np-ams-07.cloudmatchbeta.nvidiagrid.net', serverIp: null, zone: 'z', appId: '1', info: {} });
  const res = await app.inject({ method: 'GET', url: '/api/session/poll', cookies: { gfnweb_sid: sid } });
  assert.notEqual(res.statusCode, 500, `must not 500, got ${res.statusCode}: ${res.body}`);
});

// ---- 空body POST(FastifyError: Body cannot be empty)の回帰テスト ----

test('stop: Content-Type json + 空body でも 4xx/5xx にならない(実障害の再現)', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  const res = await app.inject({
    method: 'POST',
    url: '/api/session/stop',
    headers: { 'content-type': 'application/json' }, // body無し
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  assert.equal(res.json().stopped, false);
});

test('logout: 空body POST でも 200', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { 'content-type': 'application/json' },
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 200, `body: ${res.body}`);
});

test('壊れたJSON body は 400(500にしない)', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seedSession();
  const res = await app.inject({
    method: 'POST',
    url: '/api/session/stop',
    headers: { 'content-type': 'application/json' },
    payload: '{invalid json',
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 400, `body: ${res.body}`);
});

// ---- start のゾンビセッション生存確認(v0.5.9) ----

function activeStateFixture() {
  return {
    sessionId: 'old-1',
    controlBase: 'https://us-oregon.cloudmatchbeta.nvidiagrid.net',
    requestedBase: 'https://us-oregon.cloudmatchbeta.nvidiagrid.net/',
    pollBase: 'https://us-oregon.cloudmatchbeta.nvidiagrid.net/',
    serverIp: null,
    zone: 'us-oregon.cloudmatchbeta.nvidiagrid.net',
    appId: '111',
    info: { sessionId: 'old-1', status: 2 },
  };
}

function seededSessionWithRegion() {
  return store.saveSession({
    provider: { idpId: 'x', code: 'NVIDIA', displayName: 'NVIDIA', streamingServiceUrl: 'https://us-oregon.cloudmatchbeta.nvidiagrid.net/', priority: 0 },
    tokens: { accessToken: 'at', idToken: 'it', refreshToken: null, clientToken: null, expiresAt: Date.now() + 3600e3, authClientId: 'c' },
    user: { userId: 'u1', displayName: 't', email: null, avatarUrl: null, membershipTier: 'FREE' },
    deviceHashId: 'dev-1',
  });
}

test('start: 上流で失効したゾンビactive状態は自動解放され、新規作成が進む(201)', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seededSessionWithRegion();
  store.setActiveSession(sid, activeStateFixture());
  const calls = [];
  mockFetch(t, async (url, options) => {
    const u = String(url);
    calls.push(`${options?.method ?? 'GET'} ${u}`);
    if (u.includes('/v2/session/old-1')) {
      return jsonResponse({ requestStatus: { statusCode: 22, statusDescription: 'INVALID_SESSION_ID_NOT_FOUND_STATUS' } }, 404);
    }
    if (u.endsWith('/v2/session') && (!options?.method || options.method === 'GET')) {
      return jsonResponse({ requestStatus: { statusCode: 1 }, sessions: [] }); // cleanup用リスト
    }
    if (u.includes('/v2/session?') && options?.method === 'POST') {
      return jsonResponse({
        requestStatus: { statusCode: 1 },
        session: {
          sessionId: 'new-1', status: 1, connectionInfo: [],
          sessionRequestData: { appId: 555, clientRequestMonitorSettings: [{}], requestedStreamingFeatures: {} },
        },
      });
    }
    throw new Error('unexpected ' + u);
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/session/start',
    headers: { 'content-type': 'application/json' },
    payload: { appId: '555', title: 'T', settings: {} },
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 201, `body: ${res.body}`);
  assert.equal(res.json().session.sessionId, 'new-1');
  assert.equal(store.getActiveSession(sid).sessionId, 'new-1');
});

test('start: 生存しているactive状態があれば409を維持', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seededSessionWithRegion();
  store.setActiveSession(sid, activeStateFixture());
  mockFetch(t, async (url) => {
    const u = String(url);
    if (u.includes('/v2/session/old-1')) {
      return jsonResponse({
        requestStatus: { statusCode: 1 },
        session: { sessionId: 'old-1', status: 2, connectionInfo: [], sessionRequestData: { appId: 111, clientRequestMonitorSettings: [{}], requestedStreamingFeatures: {} } },
      });
    }
    throw new Error('unexpected ' + u);
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/session/start',
    headers: { 'content-type': 'application/json' },
    payload: { appId: '555', settings: {} },
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(res.statusCode, 409, `body: ${res.body}`);
  assert.equal(res.json().error, 'session_conflict');
});

// ---- start→poll の猶予期間エンドツーエンド(v0.5.10の配線検証) ----

test('start直後の全基404 pollは 410 session_gone ではなく 200 transient', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seededSessionWithRegion();
  const createdSession = {
    requestStatus: { statusCode: 1 },
    session: {
      sessionId: 'fresh-e2e', status: 1, connectionInfo: [],
      sessionRequestData: { appId: 555, clientRequestMonitorSettings: [{ widthInPixels: 1920, heightInPixels: 1080, framesPerSecond: 60 }], requestedStreamingFeatures: { codec: 1 } },
    },
  };
  mockFetch(t, async (url, options) => {
    const u = String(url);
    if (options?.method === 'POST' && u.includes('/v2/session?')) return jsonResponse(createdSession);
    if (options?.method === 'DELETE') return jsonResponse({ requestStatus: { statusCode: 1 } });
    if (u.endsWith('/v2/session')) return jsonResponse({ requestStatus: { statusCode: 1 }, sessions: [] }); // cleanup/discovery LIST
    if (u.includes('/v2/session/fresh-e2e')) {
      return jsonResponse({ requestStatus: { statusCode: 22, statusDescription: 'INVALID_SESSION_ID_NOT_FOUND_STATUS' } }, 404);
    }
    throw new Error('unexpected ' + u);
  });
  const start = await app.inject({
    method: 'POST', url: '/api/session/start',
    headers: { 'content-type': 'application/json' },
    payload: { appId: '555', settings: {} },
    cookies: { gfnweb_sid: sid },
  });
  assert.equal(start.statusCode, 201, start.body);
  const poll = await app.inject({ method: 'GET', url: '/api/session/poll', cookies: { gfnweb_sid: sid } });
  assert.equal(poll.statusCode, 200, `grace期間内は200であること: ${poll.body}`);
  assert.equal(poll.json().transient, true);
  assert.equal(poll.json().session.sessionId, 'fresh-e2e');
  // アクティブ状態は維持されている(410で解放されていない)
  assert.ok(store.getActiveSession(sid));
});

test('create 429 REQUEST_LIMIT_EXCEEDED → kind=request_limit の502', async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  const sid = seededSessionWithRegion();
  mockFetch(t, async (url, options) => {
    const u = String(url);
    if (options?.method === 'POST' && u.includes('/v2/session?')) {
      return jsonResponse({ requestStatus: { statusCode: 10, statusDescription: 'REQUEST_LIMIT_EXCEEDED_STATUS 4A8C2024' } }, 429);
    }
    if (u.endsWith('/v2/session')) return jsonResponse({ requestStatus: { statusCode: 1 }, sessions: [] });
    throw new Error('unexpected ' + u);
  });
  const res = await app.inject({
    method: 'POST', url: '/api/session/start',
    headers: { 'content-type': 'application/json' },
    payload: { appId: '555', settings: {} },
    cookies: { gfnweb_sid: sid },
  });
  // 429はgetWithRetryでリトライ後にthrow → session_error(502) + kind=request_limit
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.json().kind, 'request_limit');
});
