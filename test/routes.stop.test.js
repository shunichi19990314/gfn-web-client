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
