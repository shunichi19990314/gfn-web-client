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

// ---- ice-lite 候補合成(v0.5.14)— 実測offer(2026-09-30)をフィクスチャに ----

const REAL_OFFER_FIXTURE = [
  'v=0',
  'o=- 4373647202393833435 2 IN IP4 127.0.0.1',
  's=odrerir',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'a=ice-options:trickle',
  'a=ice-lite',
  'a=ice-ufrag:e9cb2af4',
  'a=ice-pwd:418c3716-6c0b-4b49-96a7-25d5ab646da5',
  'a=fingerprint:sha-256 96:64:F7:6F',
  'a=setup:actpass',
  'm=audio 47998 UDP/TLS/RTP/SAVPF 63 111',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'm=video 47998 UDP/TLS/RTP/SAVPF 99 100',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'm=application 47998 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:2',
  '',
].join('\r\n');

test('offerIsIceLite / extractMLinePorts: 実測offerの解析', async () => {
  const { offerIsIceLite, extractMLinePorts } = await import('../public/js/sdpUtils.js');
  assert.equal(offerIsIceLite(REAL_OFFER_FIXTURE), true);
  assert.deepEqual(extractMLinePorts(REAL_OFFER_FIXTURE), [47998]); // BUNDLE: 重複除去
});

test('buildIceLiteHostCandidate: 合成候補の形式', async () => {
  const { buildIceLiteHostCandidate, extractPublicIp } = await import('../public/js/sdpUtils.js');
  const ip = extractPublicIp('66-22-136-156.cloudmatchbeta.nvidiagrid.net');
  assert.equal(ip, '66.22.136.156');
  const cand = buildIceLiteHostCandidate(ip, 47998, 1);
  assert.equal(cand, 'candidate:1 1 udp 2130706431 66.22.136.156 47998 typ host');
  // RTCIceCandidateInit として parse 可能な形式であること
  assert.match(cand, /^candidate:\d+ 1 udp \d+ \d+\.\d+\.\d+\.\d+ \d+ typ host$/);
});

// ---- 候補ポートフォリオ(v0.5.15) ----

test('buildCandidatePortfolio: IP×ポートの直積を重複除去して生成', async () => {
  const { buildCandidatePortfolio, extractRtspsPorts } = await import('../public/js/sdpUtils.js');
  const portfolio = buildCandidatePortfolio(
    ['66.22.134.145', '66.22.134.142', '66.22.134.145'], // 重複IP
    [47998, 48322],
  );
  assert.equal(portfolio.length, 4); // 2IP × 2port
  assert.equal(portfolio[0].candidate, 'candidate:1 1 udp 2130706431 66.22.134.145 47998 typ host');
  assert.equal(portfolio[3].candidate, 'candidate:4 1 udp 2130706431 66.22.134.142 48322 typ host');
  // rtsps エンドポイントからのポート抽出
  const ports = extractRtspsPorts([
    'rtsps://66-22-134-145.cloudmatchbeta.nvidiagrid.net:322',
    'rtsps://66-22-134-145.cloudmatchbeta.nvidiagrid.net:48322',
  ]);
  assert.deepEqual(ports, [322, 48322]);
});

test('buildCandidatePortfolio: 空入力 → 空配列', async () => {
  const { buildCandidatePortfolio } = await import('../public/js/sdpUtils.js');
  assert.deepEqual(buildCandidatePortfolio([], [47998]), []);
  assert.deepEqual(buildCandidatePortfolio(['1.2.3.4'], []), []);
});

// ---- CloudMatchヘッダ: electron プロファイル(既定・v0.5.17) ----

test('cloudmatchHeaders: electronプロファイル(既定)は NATIVE/NVIDIA-CLASSIC + WINDOWS + CEF UA', async () => {
  const { cloudmatchHeaders } = await import('../src/headers.js');
  const h = cloudmatchHeaders('tok', 'dev-1', { clientId: 'cid-1' });
  assert.equal(h['nv-client-type'], 'NATIVE');
  assert.equal(h['nv-client-streamer'], 'NVIDIA-CLASSIC');
  assert.equal(h['nv-browser-type'], 'CHROME');
  assert.equal(h['nv-client-version'], '2.0.80.173');
  assert.equal(h['nv-device-os'], 'WINDOWS');
  assert.equal(h['nv-device-type'], 'DESKTOP');
  assert.equal(h['nv-device-make'], 'UNKNOWN');
  assert.equal(h['nv-device-model'], 'UNKNOWN');
  assert.equal(h['nv-client-id'], 'cid-1');
  assert.equal(h['x-device-id'], 'dev-1');
  assert.equal(h.Authorization, 'GFNJWT tok');
  assert.equal(h.Origin, 'https://play.geforcenow.com');
  assert.equal(h.Referer, 'https://play.geforcenow.com/');
  assert.ok(h['User-Agent'].includes('NVIDIACEFClient') && h['User-Agent'].includes('GFN-PC/2.0.80.173'));
  assert.equal(h['nv-client-platform-name'], undefined, 'electronプロファイルは nv-client-platform-name を送らない');
});

test('cloudmatchHeaders: browserプロファイルは BROWSER/WEBRTC(比較実験用)', async () => {
  const { cloudmatchHeaders } = await import('../src/headers.js');
  const h = cloudmatchHeaders('tok', 'dev-1', { clientId: 'cid-1', profile: 'browser' });
  assert.equal(h['nv-client-type'], 'BROWSER');
  assert.equal(h['nv-client-streamer'], 'WEBRTC');
  assert.equal(h['nv-client-platform-name'], 'browser');
  assert.equal(h['nv-browser-type'], 'CHROME');
  assert.equal(h['nv-client-id'], 'cid-1');
  assert.equal(h.Authorization, 'GFNJWT tok');
  assert.equal(h.Origin, 'https://play.geforcenow.com');
  assert.ok(!h['User-Agent'].includes('NVIDIACEFClient'), 'browserプロファイルはCEF UAを使わない');
});

test('cloudmatchHeaders: nativeプロファイルは NATIVE/NVIDIA-CLASSIC + LINUX(後方互換)', async () => {
  const { cloudmatchHeaders } = await import('../src/headers.js');
  const h = cloudmatchHeaders('tok', 'dev-1', { profile: 'native', includeOrigin: false });
  assert.equal(h['nv-client-type'], 'NATIVE');
  assert.equal(h['nv-client-streamer'], 'NVIDIA-CLASSIC');
  assert.equal(h['nv-device-os'], 'LINUX');
  assert.equal(h.Origin, undefined);
});

// ---- GFN-PC 認証コード+PKCEフロー(v0.5.17) ----

test('generatePkce: S256 challenge が verifier と整合し、base64url 形式', async () => {
  const { generatePkce } = await import('../src/nvidia.js');
  const { createHash } = await import('node:crypto');
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 86);
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge), 'base64url のみ');
  const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  assert.equal(challenge, expected);
});

test('buildPcAuthUrl: GFN-PCクライアントIDとPKCE/localhostリダイレクトを含む', async () => {
  const { buildPcAuthUrl } = await import('../src/nvidia.js');
  const { authUrl, redirectUri } = buildPcAuthUrl({ challenge: 'CHALLENGE-X', deviceId: 'dev-9', idpId: 'IDP-1' });
  const url = new URL(authUrl);
  assert.equal(url.origin + url.pathname, 'https://login.nvidia.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'ZU7sPN-miLujMD95LfOQ453IB0AtjM8sMyvgJ9wCXEQ');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:2259');
  assert.equal(redirectUri, 'http://localhost:2259');
  assert.equal(url.searchParams.get('code_challenge'), 'CHALLENGE-X');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid consent email tk_client age');
  assert.equal(url.searchParams.get('idp_id'), 'IDP-1');
  assert.equal(url.searchParams.get('device_id'), 'dev-9');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.ok((url.searchParams.get('nonce') ?? '').length >= 16);
});

test('extractAuthCode: リダイレクトURL/生コード/エラーを解析', async () => {
  const { extractAuthCode } = await import('../src/nvidia.js');
  assert.deepEqual(
    extractAuthCode('http://localhost:2259/?code=AbC-123_xyz&state=1'),
    { code: 'AbC-123_xyz', error: null },
  );
  assert.deepEqual(extractAuthCode('  AbC-123_xyz  '), { code: 'AbC-123_xyz', error: null });
  assert.deepEqual(
    extractAuthCode('http://localhost:2259/?error=access_denied&code=X'),
    { code: 'X', error: 'access_denied' },
  );
  assert.equal(extractAuthCode('').code, null);
  assert.equal(extractAuthCode('').error, 'empty');
  assert.equal(extractAuthCode('https://example.com/no-code-here').error, 'unrecognized');
});

// ---- mediaConnectionInfo 解決(Electron resolveMediaConnectionInfo 移植) ----

test('resolveMediaConnectionInfo: usage=2 → usage=17 → usage=14最高ポート の優先順位', async () => {
  const { resolveMediaConnectionInfo } = await import('../src/cloudmatch.js');
  // usage=2 優先
  assert.deepEqual(
    resolveMediaConnectionInfo([
      { ip: '10-0-0-1.example.net', port: 443, usage: 14 },
      { ip: '10.0.0.2', port: 48000, usage: 2 },
      { ip: '10.0.0.3', port: 48001, usage: 17 },
    ]),
    { ip: '10.0.0.2', port: 48000, usage: 2 },
  );
  // usage=17
  assert.deepEqual(
    resolveMediaConnectionInfo([
      { ip: '10-0-0-1.example.net', port: 443, usage: 14 },
      { ip: '10.0.0.3', port: 48001, usage: 17 },
    ]),
    { ip: '10.0.0.3', port: 48001, usage: 17 },
  );
  // usage=14 の最高ポート(Allianceフォールバック)— resourcePath からホスト/ポート抽出
  assert.deepEqual(
    resolveMediaConnectionInfo([
      { ip: '10-0-0-1.example.net', port: 443, usage: 14, resourcePath: '/nvst/' },
      { port: 0, usage: 14, resourcePath: 'rtsps://80-250-97-40.server.net:48322/session' },
    ]),
    { ip: '80-250-97-40.server.net', port: 48322, usage: 14 },
  );
  // 該当なし
  assert.equal(resolveMediaConnectionInfo([]), null);
  assert.equal(resolveMediaConnectionInfo([{ ip: '', port: 0, usage: 2 }], null), null);
});

// ---- offer ufrag 抽出(手動ICE注入用) ----

test('extractIceUfragFromOffer: offerから ice-ufrag を抽出', async () => {
  const { extractIceUfragFromOffer } = await import('../public/js/sdpUtils.js');
  const offer = 'v=0\r\na=ice-lite\r\na=ice-ufrag:2c8badaa\r\na=ice-pwd:secret\r\n';
  assert.equal(extractIceUfragFromOffer(offer), '2c8badaa');
  assert.equal(extractIceUfragFromOffer('v=0\r\n'), '');
});
