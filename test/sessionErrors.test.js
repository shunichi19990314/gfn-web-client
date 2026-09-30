// Phase 2Aフォローアップ: セッションエラー分類 / パッチ状態抽出 / クエリフォールバック
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSessionError } from '../src/cloudmatch.js';
import { appToGame, fetchLibraryPage } from '../src/nvidia.js';

// ---- describeSessionError ----

test('describeSessionError: statusCode 41 → app_patching', () => {
  const result = describeSessionError({ statusCode: 41, description: 'AppPatching' });
  assert.equal(result.kind, 'app_patching');
  assert.match(result.messageJa, /更新/);
});

test('describeSessionError: statusDescription の APP_PATCHING_STATUS から推定(実障害ケース)', () => {
  // ユーザー報告: "Session creation failed (502): APP_PATCHING_STATUS 8A910015"
  const result = describeSessionError({ statusCode: null, description: 'APP_PATCHING_STATUS 8A910015' });
  assert.equal(result.kind, 'app_patching');
});

test('describeSessionError: その他の既知コード', () => {
  assert.equal(describeSessionError({ statusCode: 58 }).kind, 'capacity');
  assert.equal(describeSessionError({ statusCode: 23 }).kind, 'eula');
  assert.equal(describeSessionError({ statusCode: 26 }).kind, 'steam_login');
  assert.equal(describeSessionError({ statusCode: 56 }).kind, 'app_maintenance');
  assert.equal(describeSessionError({ statusCode: 62 }).kind, 'queue_full');
  assert.equal(describeSessionError({ description: 'SERVER_SESSION_QUEUE_LENGTH_EXCEEDED' }).kind, 'queue_full');
});

test('describeSessionError: 未知のコードは null', () => {
  assert.equal(describeSessionError({ statusCode: 999, description: 'WEIRD' }), null);
});

// ---- appToGame: stateDetails ----

function makeApp(stateDetails, extraLibrary = {}) {
  return {
    id: 'APP-1',
    title: 'Test Game',
    images: {},
    variants: [{
      id: '12345',
      appStore: 'STEAM',
      gfn: {
        status: 'AVAILABLE',
        features: [],
        library: { status: 'PLATFORM_SYNC', selected: true, lastPlayedDate: null, ...extraLibrary },
        stateDetails,
      },
    }],
    gfn: { playType: 'CLOUD_NATIVE' },
  };
}

test('appToGame: AutoPatching → patchLevel=auto / isUpdating / endTime', () => {
  const game = appToGame(makeApp([
    { __typename: 'VariantGfnAutoPatchingMetadata', subType: 'GAME_UPDATE', endTime: 1790000000000 },
  ]));
  assert.equal(game.patchLevel, 'auto');
  assert.equal(game.isUpdating, true);
  assert.equal(game.updateEndTime, 1790000000000);
  assert.equal(game.variants[0].patching, 'auto');
});

test('appToGame: ManualPatching → patchLevel=manual(起動は許可する想定)', () => {
  const game = appToGame(makeApp([
    { __typename: 'VariantGfnManualPatchingMetadata', subType: 'PATCH', endTime: null },
  ]));
  assert.equal(game.patchLevel, 'manual');
  assert.equal(game.isUpdating, true);
});

test('appToGame: Maintenance → inMaintenance', () => {
  const game = appToGame(makeApp([
    { __typename: 'VariantGfnMaintenanceMetadata', subType: 'MAINTENANCE' },
  ]));
  assert.equal(game.inMaintenance, true);
  assert.equal(game.patchLevel, null);
});

test('appToGame: stateDetails なし(旧クエリ応答)でも従来通り動作', () => {
  const game = appToGame(makeApp(undefined));
  assert.equal(game.patchLevel, null);
  assert.equal(game.isUpdating, false);
  assert.equal(game.launchAppId, '12345');
});

// ---- fetchLibraryPage: V2 → レガシー フォールバック ----

function graphqlOk(items) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({
      data: { apps: { pageInfo: { hasNextPage: false, endCursor: '', totalCount: items.length }, items } },
    }),
  };
}

test('fetchLibraryPage: V2クエリがスキーマエラーならレガシーで再試行', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const bodies = [];
  let call = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ errors: [{ message: 'Unknown field "stateDetails" on type "VariantGfn"' }] }),
      };
    }
    return graphqlOk([makeApp(undefined)]);
  };
  const page = await fetchLibraryPage({ token: 'jwt', vpcId: 'GFN-PC' });
  assert.equal(call, 2);
  assert.equal(page.games.length, 1);
  assert.match(bodies[0].query, /stateDetails/); // 1回目はV2
  assert.doesNotMatch(bodies[1].query, /stateDetails/); // 2回目はレガシー
});

test('fetchLibraryPage: V2が成功すれば1回だけ', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return graphqlOk([makeApp([{ __typename: 'VariantGfnAutoPatchingMetadata', subType: 'X', endTime: null }])]);
  };
  const page = await fetchLibraryPage({ token: 'jwt', vpcId: 'GFN-PC' });
  assert.equal(call, 1);
  assert.equal(page.games[0].patchLevel, 'auto');
});

// ---- queue_abandoned(実障害 2026-09-29)と残留掃除 ----

test('describeSessionError: statusCode 69 → queue_abandoned', async () => {
  const { describeSessionError } = await import('../src/cloudmatch.js');
  assert.equal(describeSessionError({ statusCode: 69 }).kind, 'queue_abandoned');
  assert.equal(describeSessionError({ statusCode: 64 }).kind, 'forward_expired');
});

test('describeSessionError: SESSION_REQUEST_IN_QUEUE_ABANDONED 文字列から推定', async () => {
  const { describeSessionError } = await import('../src/cloudmatch.js');
  // 実障害のレスポンス: HTTP 503 + statusDescription
  const result = describeSessionError({ statusCode: null, description: 'SESSION_REQUEST_IN_QUEUE_ABANDONED 4A8C300F' });
  assert.equal(result.kind, 'queue_abandoned');
});

test('cleanupStaleSessions: キュー残り(status1)と自デバイスのみ削除、他デバイスの配信中は残す', async (t) => {
  const { cleanupStaleSessions } = await import('../src/cloudmatch.js');
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const deleted = [];
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/v2/session') && (!options?.method || options.method === 'GET')) {
      return {
        ok: true, status: 200, headers: new Headers(),
        text: async () => JSON.stringify({
          requestStatus: { statusCode: 1 },
          sessions: [
            { sessionId: 'queued-other', status: 1, sessionRequestData: { deviceHashId: 'other-device', appId: 5 } },
            { sessionId: 'streaming-other', status: 3, sessionRequestData: { deviceHashId: 'other-device', appId: 6 } },
            { sessionId: 'mine-paused', status: 4, sessionRequestData: { deviceHashId: 'my-device', appId: 7 } },
          ],
        }),
      };
    }
    if (options?.method === 'DELETE') {
      deleted.push(u);
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{"requestStatus":{"statusCode":1}}' };
    }
    throw new Error('unexpected ' + u);
  };
  const removed = await cleanupStaleSessions({
    bases: ['https://us-oregon.cloudmatchbeta.nvidiagrid.net/'],
    token: 'jwt',
    deviceHashId: 'my-device',
  });
  assert.equal(removed.length, 2);
  assert.ok(deleted.some((d) => d.includes('queued-other')));   // 他デバイスでもキュー残りは削除
  assert.ok(deleted.some((d) => d.includes('mine-paused')));    // 自デバイスは状態問わず削除
  assert.ok(!deleted.some((d) => d.includes('streaming-other'))); // 他デバイスの配信中は絶対に残す
});

// ---- fixServerIp: bare candidate 行対応(v0.5.13) ----

test('fixServerIp: a= なし candidate 行の 0.0.0.0 も置換', async () => {
  const { fixServerIp } = await import('../public/js/sdpUtils.js');
  const sdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'candidate:1 1 udp 2130706431 0.0.0.0 50000 typ host',
    'a=candidate:2 1 udp 1694498815 0.0.0.0 50001 typ srflx',
    '',
  ].join('\r\n');
  const fixed = fixServerIp(sdp, '66-22-140-145.cloudmatchbeta.nvidiagrid.net');
  assert.match(fixed, /candidate:1 1 udp 2130706431 66\.22\.140\.145 50000 typ host/);
  assert.match(fixed, /a=candidate:2 1 udp 1694498815 66\.22\.140\.145 50001 typ srflx/);
  // c= 行は公式クライアント同様に変えない
  assert.match(fixed, /c=IN IP4 0\.0\.0\.0/);
});
