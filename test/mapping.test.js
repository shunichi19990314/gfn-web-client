// appToGame / userFromJwt / fetchProviders / fetchServerInfo / isTrustedStreamingBase のユニットテスト
// 実行: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { appToGame, fetchProviders, fetchServerInfo, userFromJwt } from '../src/nvidia.js';
import { isTrustedStreamingBase } from '../src/config.js';

// ---- fixture: GraphQL apps.items の1件(gfn.rs LIBRARY_QUERY スキーマ準拠) ----
const libraryItem = {
  id: 'APP-123',
  title: ' Portal 2 ',
  developerName: 'Valve',
  publisherName: 'Valve Publishing',
  genres: ['Action', 'Puzzle'],
  supportedControls: ['KEYBOARD_MOUSE', 'GAMEPAD'],
  images: {
    GAME_BOX_ART: 'https://img.nvidiagrid.net/apps/game/PORTAL2/BOX.png',
    KEY_ART: ['https://img.nvidiagrid.net/apps/game/PORTAL2/KEY_ART.jpg'],
    HERO_IMAGE: 'https://img.nvidiagrid.net/apps/game/PORTAL2/HERO.jpg',
    SCREENSHOTS: ['https://img.nvidiagrid.net/apps/game/PORTAL2/SS1.jpg'],
  },
  variants: [
    {
      id: 'variant-uuid-not-numeric',
      appStore: 'EPIC',
      storeUrl: 'https://store.example/portal2',
      supportedControls: ['KEYBOARD_MOUSE'],
      gfn: {
        status: 'AVAILABLE',
        features: [{ __typename: 'GfnSubscriptionFeatureValue', key: 'IN_GAME_SETTINGS_PERSISTENCE_ENABLED', value: 'true' }],
        library: { status: 'PLATFORM_SYNC', selected: false, lastPlayedDate: '2026-09-01T10:00:00Z' },
      },
    },
    {
      id: '620123',
      appStore: 'STEAM',
      storeUrl: 'https://store.steampowered.com/app/620/Portal_2/',
      supportedControls: ['KEYBOARD_MOUSE', 'GAMEPAD'],
      gfn: {
        status: 'AVAILABLE',
        features: [],
        library: { status: 'PLATFORM_SYNC', selected: true, lastPlayedDate: '2026-09-20T10:00:00Z' },
      },
    },
  ],
  gfn: {
    playType: 'CLOUD_NATIVE',
    playabilityState: 'PLAYABLE',
    minimumMembershipTierLabel: 'free',
    catalogSkuStrings: {},
  },
  itemMetadata: { campaignIds: [] },
};

test('appToGame: 基本マッピング', () => {
  const game = appToGame(libraryItem);
  assert.ok(game);
  assert.equal(game.title, 'Portal 2'); // trim される
  assert.equal(game.id, 'APP-123');
  assert.equal(game.launchAppId, '620123'); // selected variant(数字ID)が選ばれる
  assert.equal(game.selectedVariantIndex, 1);
  assert.equal(game.imageUrl, 'https://img.nvidiagrid.net/apps/game/PORTAL2/BOX.png;f=jpg;w=900'); // img.nvidiagrid.net は suffix 付与
  assert.equal(game.keyArtUrl, 'https://img.nvidiagrid.net/apps/game/PORTAL2/KEY_ART.jpg;f=jpg;w=900');
  assert.deepEqual(game.genres, ['Action', 'Puzzle']);
  assert.deepEqual(game.availableStores, ['EPIC', 'STEAM']);
  assert.equal(game.isInLibrary, true);
  assert.equal(game.membershipTierLabel, 'free');
  assert.equal(game.variants[0].supportsInGameSettingsPersistence, true);
  assert.equal(game.variants[1].supportsInGameSettingsPersistence, false);
  assert.ok(game.searchText.includes('portal 2'));
  assert.ok(game.searchText.includes('steam'));
});

test('appToGame: variants が空なら null', () => {
  assert.equal(appToGame({ id: 'x', title: 'y', variants: [] }), null);
});

test('appToGame: title が空なら null', () => {
  assert.equal(appToGame({ id: 'x', title: '  ', variants: libraryItem.variants }), null);
});

test('appToGame: launchAppId フォールバック(数字ID優先探索)', () => {
  const app = structuredClone(libraryItem);
  app.variants[0].gfn.library.selected = false;
  app.variants[1].gfn.library.selected = false;
  app.variants[1].gfn.library.status = null;
  const game = appToGame(app);
  assert.equal(game.launchAppId, '620123');
});

test('userFromJwt: JWTペイロードをデコード', () => {
  const payload = { sub: 'user-1', email: 'a@b.c', preferred_username: 'tester', picture: 'https://img/p.png' };
  const jwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  const user = userFromJwt(jwt);
  assert.deepEqual(user, { userId: 'user-1', email: 'a@b.c', displayName: 'tester', avatarUrl: 'https://img/p.png' });
  assert.equal(userFromJwt('garbage'), null);
});

test('fetchProviders: gfnServiceEndpoints をパースし priority 順。空ならNVIDIA既定', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({
      gfnServiceInfo: {
        gfnServiceEndpoints: [
          { loginProviderCode: 'NVIDIA', idpId: 'idp-nv', loginProviderDisplayName: 'NVIDIA', streamingServiceUrl: 'https://prod.cloudmatchbeta.nvidiagrid.net', loginProviderPriority: 5 },
          { loginProviderCode: 'BPC', idpId: 'idp-bpc', loginProviderDisplayName: 'ignored', streamingServiceUrl: 'https://prod.bpc.geforcenow.nvidiagrid.net/', loginProviderPriority: 1 },
        ],
      },
    }),
  });
  const providers = await fetchProviders();
  assert.equal(providers.length, 2);
  assert.equal(providers[0].code, 'BPC'); // priority 昇順
  assert.equal(providers[0].displayName, 'bro.game'); // BPC は固定名
  assert.equal(providers[1].streamingServiceUrl, 'https://prod.cloudmatchbeta.nvidiagrid.net/'); // 末尾 / 正規化

  globalThis.fetch = async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => '' });
  const fallback = await fetchProviders();
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].code, 'NVIDIA');
});

test('fetchServerInfo: vpcId とリージョンを抽出', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://prod.cloudmatchbeta.nvidiagrid.net/v2/serverInfo');
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        requestStatus: { serverId: 'GFN-PC-JP' },
        metaData: [
          { key: 'local-region', value: 'NP-TYO-01' },
          { key: 'gfn-regions', value: 'NP-TYO-01, NP-LAX-01' },
          { key: 'NP-TYO-01', value: 'https://np-tyo-01.cloudmatchbeta.nvidiagrid.net' },
          { key: 'NP-LAX-01', value: 'https://np-lax-01.cloudmatchbeta.nvidiagrid.net/' },
        ],
      }),
    };
  };
  const info = await fetchServerInfo('https://prod.cloudmatchbeta.nvidiagrid.net/', 'jwt-token');
  assert.equal(info.vpcId, 'GFN-PC-JP');
  assert.equal(info.localRegion, 'NP-TYO-01');
  assert.deepEqual(info.regions.map((r) => r.name), ['NP-TYO-01', 'NP-LAX-01']);
  assert.ok(info.regions.every((r) => r.url.endsWith('/')));
});

test('fetchServerInfo: 信頼できない基は拒否', async () => {
  await assert.rejects(() => fetchServerInfo('https://evil.example/', 'token'), /Untrusted/);
});

test('isTrustedStreamingBase', () => {
  assert.equal(isTrustedStreamingBase('https://prod.cloudmatchbeta.nvidiagrid.net/'), true);
  assert.equal(isTrustedStreamingBase('https://prod.bpc.geforcenow.nvidiagrid.net/'), true);
  assert.equal(isTrustedStreamingBase('https://cloudmatchbeta.nvidiagrid.net.attacker.example/'), false);
  assert.equal(isTrustedStreamingBase('http://prod.cloudmatchbeta.nvidiagrid.net/'), false);
});
