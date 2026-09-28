// validateImportedToken のユニットテスト(fetchモック)
// 検証は MES(mes.geforcenow.com)で行う — serverInfo/GraphQLは公開のため検証に使えない
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateImportedToken } from '../src/nvidia.js';

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

function mockFetch(t, handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = realFetch; });
}

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify(payload),
});

const PROVIDERS_PAYLOAD = {
  gfnServiceInfo: {
    gfnServiceEndpoints: [
      { loginProviderCode: 'NVIDIA', idpId: 'idp-nv', loginProviderDisplayName: 'NVIDIA', streamingServiceUrl: 'https://prod.cloudmatchbeta.nvidiagrid.net/', loginProviderPriority: 1 },
    ],
  },
};

const MES_PAYLOAD = {
  membershipTier: 'PRIORITY',
  allottedTimeInMinutes: 0,
  remainingTimeInMinutes: 0,
  features: { resolutions: [{ isEntitled: true, widthInPixels: 2560, heightInPixels: 1440, framesPerSecond: 120 }] },
  addons: [],
};

test('import: 有効なJWT + MES 200 → セッション材料とmembershipTierを返す', async (t) => {
  const token = makeJwt({
    sub: 'user-42',
    email: 'player@example.com',
    preferred_username: 'player42',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const calls = [];
  mockFetch(t, async (url) => {
    calls.push(String(url));
    if (String(url).includes('serviceUrls')) return jsonResponse(PROVIDERS_PAYLOAD);
    if (String(url).includes('v2/serverInfo')) return jsonResponse({ requestStatus: { serverId: 'GFN-PC' }, metaData: [] });
    if (String(url).includes('mes.geforcenow.com')) return jsonResponse(MES_PAYLOAD);
    throw new Error(`unexpected fetch: ${url}`);
  });

  const result = await validateImportedToken(token);
  assert.equal(result.user.userId, 'user-42');
  assert.equal(result.user.email, 'player@example.com');
  assert.equal(result.user.displayName, 'player42');
  assert.equal(result.provider.code, 'NVIDIA');
  assert.equal(result.vpcId, 'GFN-PC');
  assert.equal(result.membershipTier, 'PRIORITY');
  assert.ok(result.expiresAt > Date.now());
  // email が JWT にあるため userinfo は呼ばれない
  assert.ok(!calls.some((c) => c.includes('userinfo')));
});

test('import: serverInfo が失敗しても MES が通れば成功(vpcIdフォールバック)', async (t) => {
  const token = makeJwt({ sub: 'user-42', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 3600 });
  mockFetch(t, async (url) => {
    if (String(url).includes('serviceUrls')) return jsonResponse(PROVIDERS_PAYLOAD);
    if (String(url).includes('v2/serverInfo')) return jsonResponse({ error: 'boom' }, 500);
    if (String(url).includes('mes.geforcenow.com')) return jsonResponse(MES_PAYLOAD);
    throw new Error(`unexpected fetch: ${url}`);
  });
  const result = await validateImportedToken(token);
  assert.equal(result.vpcId, 'GFN-PC');
  assert.equal(result.membershipTier, 'PRIORITY');
});

test('import: JWT形式でない → invalid_params(upstream呼び出しなし)', async () => {
  await assert.rejects(() => validateImportedToken('not-a-jwt'), (error) => {
    assert.equal(error.code, 'invalid_params');
    return true;
  });
});

test('import: sub なしJWT → invalid_params', async () => {
  const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await assert.rejects(() => validateImportedToken(token), (error) => {
    assert.equal(error.code, 'invalid_params');
    return true;
  });
});

test('import: 期限切れJWT → authentication_required(upstream呼び出しなし)', async () => {
  const token = makeJwt({ sub: 'user-42', exp: Math.floor(Date.now() / 1000) - 10 });
  await assert.rejects(() => validateImportedToken(token), (error) => {
    assert.equal(error.code, 'authentication_required');
    return true;
  });
});

test('import: MES が401(偽造/失効トークン) → authentication_required', async (t) => {
  const token = makeJwt({ sub: 'user-42', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 3600 });
  mockFetch(t, async (url) => {
    if (String(url).includes('serviceUrls')) return jsonResponse(PROVIDERS_PAYLOAD);
    if (String(url).includes('v2/serverInfo')) return jsonResponse({ requestStatus: { serverId: 'GFN-PC' }, metaData: [] });
    if (String(url).includes('mes.geforcenow.com')) return jsonResponse({ error: 'unauthorized', message: 'invalid token' }, 401);
    throw new Error(`unexpected fetch: ${url}`);
  });
  await assert.rejects(() => validateImportedToken(token), (error) => {
    assert.equal(error.code, 'authentication_required');
    return true;
  });
});
