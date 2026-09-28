// cloudmatch.js のユニットテスト(build_create_body / session_info / ヘルパー移植の検証)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCreateBody,
  buildResumeBody,
  codecWire,
  colorQualityWire,
  normalizeIceServers,
  parseResolution,
  regionalBases,
  sessionInfo,
  sessionPhase,
  signalingUrl,
  trustedCloudmatchBase,
  trustedLearnedServerBase,
} from '../src/cloudmatch.js';

// ---- build_create_body ----

test('buildCreateBody: 既定設定の主要フィールド', () => {
  const body = buildCreateBody({ appId: '12345', params: { title: 'Portal 2' }, settings: {}, deviceHashId: 'dev-uuid' });
  const req = body.sessionRequestData;
  assert.equal(req.appId, 12345);
  assert.equal(req.internalTitle, 'Portal 2');
  assert.equal(req.clientIdentification, 'GFN-PC');
  assert.equal(req.clientVersion, '30.0');
  assert.equal(req.streamerVersion, '14');
  assert.equal(req.deviceHashId, 'dev-uuid');
  assert.equal(req.secureRTSPSupported, true);
  assert.equal(req.audioMode, 2);
  assert.equal(req.useOps, true);
  const monitor = req.clientRequestMonitorSettings[0];
  assert.equal(monitor.widthInPixels, 1920);
  assert.equal(monitor.heightInPixels, 1080);
  assert.equal(monitor.framesPerSecond, 60);
  assert.equal(monitor.dpi, 96);
  const features = req.requestedStreamingFeatures;
  assert.equal(features.codec, 0); // auto
  assert.equal(features.maxBitrateKbps, 75000); // 75Mbps既定
  assert.equal(features.audioChannelCount, 2);
  assert.equal(features.trueHdr, false);
  // metaData の wssignaling=1 が含まれること(WebSocketシグナリングの要求)
  const wss = req.metaData.find((m) => m.key === 'wssignaling');
  assert.equal(wss?.value, '1');
  const sub = req.metaData.find((m) => m.key === 'SubSessionId');
  assert.ok(sub?.value && sub.value.length > 10);
  assert.equal(typeof req.clientTimezoneOffset, 'number');
});

test('buildCreateBody: codec/解像度/fps/bitrate のワイヤー値', () => {
  const body = buildCreateBody({
    appId: '1',
    settings: { codec: 'av1', resolution: '2560x1440', fps: 120, maxBitrateMbps: 40, colorQuality: '10bit_420' },
    deviceHashId: 'd',
  }).sessionRequestData;
  assert.equal(body.requestedStreamingFeatures.codec, 3);
  assert.equal(body.requestedStreamingFeatures.maxBitrateKbps, 40000);
  assert.equal(body.requestedStreamingFeatures.bitDepth, 1); // AV1+10bit(非HDR)
  assert.equal(body.clientRequestMonitorSettings[0].widthInPixels, 2560);
  assert.equal(body.clientRequestMonitorSettings[0].framesPerSecond, 120);
  assert.equal(body.requestedStreamingFeatures.reflex, true); // fps>=120
});

test('codecWire / colorQualityWire / parseResolution / sessionPhase', () => {
  assert.equal(codecWire('h264'), 1);
  assert.equal(codecWire('HEVC'), 2);
  assert.equal(codecWire('av1'), 3);
  assert.equal(codecWire('auto'), 0);
  assert.deepEqual(colorQualityWire('8bit_420'), [0, 0]);
  assert.deepEqual(colorQualityWire('10bit_444'), [1, 1]);
  assert.deepEqual(parseResolution('bogus'), { width: 1920, height: 1080 });
  assert.equal(sessionPhase(1), 'preparing');
  assert.equal(sessionPhase(2), 'ready');
  assert.equal(sessionPhase(3), 'streaming');
  assert.equal(sessionPhase(4), 'paused');
  assert.equal(sessionPhase(6), 'resuming');
  assert.equal(sessionPhase(7), 'failed');
  assert.equal(sessionPhase(0), 'requesting');
});

test('buildResumeBody: action=2/RESUME、clientPhysicalResolutionを含まない', () => {
  const session = { sessionRequestData: { appLaunchMode: 1, enablePersistingInGameSettings: true, clientPlatformName: 'Windows' }, sdrHdrMode: 0 };
  const body = buildResumeBody({ appId: '999', session, settings: {}, deviceHashId: 'd' });
  assert.equal(body.action, 2);
  assert.equal(body.data, 'RESUME');
  assert.ok(!body.sessionRequestData.metaData.some((m) => m.key === 'clientPhysicalResolution'));
  assert.equal(body.sessionRequestData.appId, 999);
});

// ---- session_info ----

const sessionPayload = {
  requestStatus: { statusCode: 1, serverId: 'GFN-PC' },
  session: {
    sessionId: 'sess-1',
    subSessionId: 'sub-1',
    status: 2,
    connectionInfo: [
      { usage: 14, ip: '80-250-97-40.cloudmatchbeta.nvidiagrid.net', port: 443, resourcePath: '/nvst/' },
      { usage: 16, resourcePath: 'rtsps://80-250-97-40.cloudmatchbeta.nvidiagrid.net:322' },
      { usage: 2, ip: '80.250.97.40', port: 50000 },
    ],
    sessionControlInfo: { ip: 'prod.cloudmatchbeta.nvidiagrid.net' },
    iceServerConfiguration: {
      iceServers: [{ urls: ['turn:turn.gamestream.nvidia.com:3478'], username: 'u', credential: 'c' }],
    },
    sessionRequestData: {
      appId: 12345,
      clientRequestMonitorSettings: [{ widthInPixels: 1920, heightInPixels: 1080, framesPerSecond: 60 }],
      requestedStreamingFeatures: { codec: 1, maxBitrateKbps: 40000 },
    },
    negotiatedStreamProfile: { codec: 'H264' },
    serverLocation: 'US-West',
    gpuType: 'RTX',
  },
};

test('sessionInfo: 主要フィールドの抽出', () => {
  const info = sessionInfo(sessionPayload, {
    fallbackBase: 'https://prod.cloudmatchbeta.nvidiagrid.net/',
    zone: 'prod.cloudmatchbeta.nvidiagrid.net',
    fallbackAppId: '12345',
    deviceId: 'dev',
  });
  assert.equal(info.sessionId, 'sess-1');
  assert.equal(info.status, 2);
  assert.equal(info.phase, 'ready');
  assert.equal(info.serverIp, '80-250-97-40.cloudmatchbeta.nvidiagrid.net');
  assert.equal(info.signalingUrl, 'wss://80-250-97-40.cloudmatchbeta.nvidiagrid.net:443/nvst/');
  assert.equal(info.streamingBaseUrl, 'https://prod.cloudmatchbeta.nvidiagrid.net');
  assert.deepEqual(info.rtspsEndpoints, ['rtsps://80-250-97-40.cloudmatchbeta.nvidiagrid.net:322']);
  assert.deepEqual(info.mediaConnectionInfo, { ip: '80.250.97.40', port: 50000, usage: 2 });
  assert.equal(info.iceServers.length, 1); // 空でないためSTUNフォールバックなし
  assert.equal(info.negotiatedStreamProfile.codec, 'H264');
  assert.equal(info.negotiatedStreamProfile.resolution, '1920x1080');
  assert.equal(info.gpuType, 'RTX');
  assert.equal(info.appId, '12345');
});

test('sessionInfo: ICEが空ならSTUNフォールバック3件', () => {
  const payload = structuredClone(sessionPayload);
  delete payload.session.iceServerConfiguration;
  const info = sessionInfo(payload, { fallbackBase: 'https://prod.cloudmatchbeta.nvidiagrid.net/', zone: 'z', fallbackAppId: '1', deviceId: 'd' });
  assert.equal(info.iceServers.length, 3);
  assert.ok(info.iceServers[0].urls[0].includes('stun'));
});

// ---- ヘルパー ----

test('signalingUrl: rtsps→wss / パス / そのまま', () => {
  assert.equal(signalingUrl('rtsps://host:322', 'ip'), 'wss://host:322');
  assert.equal(signalingUrl('/nvst/', '1.2.3.4'), 'wss://1.2.3.4:443/nvst/');
  assert.equal(signalingUrl('wss://x/y', 'ip'), 'wss://x/y');
  assert.equal(signalingUrl('', '1.2.3.4'), 'wss://1.2.3.4:443/nvst/');
});

test('regionalBases: local-region + gfn-regions から信頼基のみ', () => {
  const payload = {
    metaData: [
      { key: 'local-region', value: 'NP-TYO-01' },
      { key: 'gfn-regions', value: 'NP-TYO-01, NP-LAX-01, EVIL' },
      { key: 'NP-TYO-01', value: 'https://np-tyo-01.cloudmatchbeta.nvidiagrid.net' },
      { key: 'NP-LAX-01', value: 'https://np-lax-01.cloudmatchbeta.nvidiagrid.net/' },
      { key: 'EVIL', value: 'https://cloudmatchbeta.nvidiagrid.net.evil.example/' },
    ],
  };
  const bases = regionalBases(payload);
  assert.deepEqual(bases.map((b) => b.hostname), ['np-tyo-01.cloudmatchbeta.nvidiagrid.net', 'np-lax-01.cloudmatchbeta.nvidiagrid.net']);
});

test('trustedLearnedServerBase: ダッシュホスト名/IPを信頼、private/外部ホストを拒否', () => {
  assert.ok(trustedLearnedServerBase('80-250-97-40.cloudmatchbeta.nvidiagrid.net'));
  assert.ok(trustedLearnedServerBase('80.250.97.40'));
  assert.equal(trustedLearnedServerBase('10.0.0.1'), null); // private IPv4
  assert.equal(trustedLearnedServerBase('127.0.0.1'), null); // loopback
  assert.equal(trustedLearnedServerBase('evil.example'), null);
  assert.equal(trustedLearnedServerBase('https://nvidiagrid.net.attacker.example'), null);
});

test('trustedCloudmatchBase: 信頼ホストのみ', () => {
  assert.ok(trustedCloudmatchBase('https://prod.cloudmatchbeta.nvidiagrid.net'));
  assert.ok(trustedCloudmatchBase('https://th.bpc.geforcenow.nvidiagrid.net'));
  assert.equal(trustedCloudmatchBase('http://prod.cloudmatchbeta.nvidiagrid.net'), null);
  assert.equal(trustedCloudmatchBase('https://prod.cloudmatchbeta.nvidiagrid.net.attacker.example'), null);
});

test('normalizeIceServers: username/credential 透過', () => {
  const servers = normalizeIceServers({ iceServerConfiguration: { iceServers: [{ urls: 'turn:t:3478', username: 'u', credential: 'c' }] } });
  assert.deepEqual(servers[0], { urls: ['turn:t:3478'], username: 'u', credential: 'c' });
});
