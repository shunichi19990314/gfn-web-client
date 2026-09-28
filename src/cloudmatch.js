// CloudMatch セッションAPI クライアント
// OpenNOW (MIT) native/opennow-core/src/cloudmatch.rs のJS移植
// 行番号対応: build_create_body=886 / session_info=994 / validate=1290 / conflict=1333 /
//            regional_bases=1575 / ice=1608 / signaling_url=1676 / phase=1695 / codec=1746
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { DEFAULT_STREAMING_URL } from './config.js';
import { cloudmatchHeaders, lcarsHeaders } from './headers.js';
import { UpstreamError, assertOk, fetchJson } from './upstream.js';

const DEFAULT_STUN_SERVER = 'stun:s1.stun.gamestream.nvidia.com:19308';
const CONFLICT_ERROR_CODE = '4AF1201E';

// ---------- 小さなヘルパー ----------

export function codecWire(value) {
  switch (String(value ?? '').toLowerCase()) {
    case 'h264': return 1;
    case 'h265':
    case 'hevc': return 2;
    case 'av1': return 3;
    default: return 0; // auto: CloudMatchに委譲
  }
}

export function codecFromWire(value) {
  return value === 1 ? 'H264' : value === 2 ? 'H265' : value === 3 ? 'AV1' : null;
}

export function colorQualityWire(value) {
  switch (value) {
    case '10bit_420': return [1, 0];
    case '8bit_444': return [0, 1];
    case '10bit_444': return [1, 1];
    default: return [0, 0]; // 8bit_420
  }
}

export function parseResolution(value) {
  const [w, h] = String(value ?? '1920x1080').split('x');
  const width = Number.parseInt(w, 10);
  const height = Number.parseInt(h, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }
  return { width, height };
}

export function sessionPhase(status) {
  if (status === 1) return 'preparing';
  if (status === 2) return 'ready';
  if (status === 3) return 'streaming';
  if (status === 4 || status === 5) return 'paused';
  if (status === 6) return 'resuming';
  if (status > 3) return 'failed';
  return 'requesting';
}

export function appLaunchMode(params) {
  return params?.appLaunchMode === 'gamepadFriendly' ? 2 : params?.appLaunchMode === 'touchFriendly' ? 3 : 1;
}

export function isZoneHostname(value) {
  const host = String(value ?? '').trim().replace(/\.+$/, '').toLowerCase();
  return (
    host === 'cloudmatchbeta.nvidiagrid.net' ||
    host.endsWith('.cloudmatchbeta.nvidiagrid.net') ||
    host === 'cloudmatch.nvidiagrid.net' ||
    host.endsWith('.cloudmatch.nvidiagrid.net')
  );
}

function valueI64(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

function firstString(value) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.length > 0) return firstString(value[0]);
  return null;
}

/** 学習したサーバーIP/ホストを信頼できるhttps基に変換(cloudmatch.rs:1397-1435) */
export function trustedLearnedServerBase(server) {
  let raw;
  if (String(server).startsWith('https://')) raw = server;
  else if (String(server).includes(':') && net.isIP(String(server).split(':')[0])) raw = `https://[${server}]`;
  else raw = `https://${server}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.+$/, '').toLowerCase();
  const ipVersion = net.isIP(host.replace(/^\[|\]$/g, ''));
  const trustedHostname = host === 'nvidiagrid.net' || host.endsWith('.nvidiagrid.net');
  let trustedIp = false;
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    const [a] = parts;
    trustedIp =
      a !== 10 &&
      a !== 127 &&
      !(a === 169 && parts[1] === 254) &&
      a !== 0 &&
      !(a === 172 && parts[1] >= 16 && parts[1] <= 31) &&
      !(a === 192 && parts[1] === 168);
  } else if (ipVersion === 6) {
    trustedIp = host !== '::' && host !== '::1' && !host.toLowerCase().startsWith('fe80');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    (!trustedHostname && !trustedIp)
  ) {
    return null;
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

/** CloudMatchゾーン基の検証(cloudmatch.rs:1376-1395) */
export function trustedCloudmatchBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.+$/, '').toLowerCase();
  const trusted =
    host === 'cloudmatchbeta.nvidiagrid.net' ||
    host.endsWith('.cloudmatchbeta.nvidiagrid.net') ||
    host.endsWith('.geforcenow.nvidiagrid.net');
  if (url.protocol !== 'https:' || !trusted) return null;
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

export function hostFromResource(resource) {
  const translated = String(resource).replace(/^rtsps:\/\//, 'https://').replace(/^rtsp:\/\//, 'http://');
  try {
    return new URL(translated).hostname;
  } catch {
    return null;
  }
}

/** rtsps:// → wss:// 変換等(cloudmatch.rs:1676-1693) */
export function signalingUrl(resource, serverIp) {
  const r = String(resource ?? '');
  if (r.startsWith('rtsps://') || r.startsWith('rtsp://')) {
    const idx = r.indexOf('://');
    return `wss://${idx >= 0 ? r.slice(idx + 3) : r}`;
  }
  if (r.startsWith('wss://')) return r;
  if (r.startsWith('/')) return `wss://${serverIp}:443${r}`;
  return `wss://${serverIp}:443/nvst/`;
}

export function regionalBases(payload) {
  const metadata = Array.isArray(payload?.metaData) ? payload.metaData : [];
  const valueFor = (key) => {
    const entry = metadata.find((e) => e?.key === key);
    return typeof entry?.value === 'string' ? entry.value : null;
  };
  const names = [];
  const local = valueFor('local-region');
  if (local) names.push(local);
  for (const name of (valueFor('gfn-regions') ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
  }
  const result = [];
  for (const name of names) {
    const raw = valueFor(name);
    if (!raw) continue;
    const base = trustedCloudmatchBase(raw);
    if (base && !result.some((existing) => existing.href === base.href)) result.push(base);
  }
  return result;
}

export function normalizeIceServers(session) {
  const raw = Array.isArray(session?.iceServerConfiguration?.iceServers) ? session.iceServerConfiguration.iceServers : [];
  const servers = raw
    .map((entry) => {
      const urls = Array.isArray(entry?.urls) ? entry.urls : typeof entry?.urls === 'string' ? [entry.urls] : null;
      if (!urls || urls.length === 0) return null;
      return { urls, username: entry.username ?? undefined, credential: entry.credential ?? undefined };
    })
    .filter(Boolean);
  if (servers.length === 0) {
    servers.push({ urls: [DEFAULT_STUN_SERVER] });
    servers.push({ urls: ['stun:stun.l.google.com:19302'] });
    servers.push({ urls: ['stun:stun1.l.google.com:19302'] });
  }
  return servers;
}

export function queuePosition(session) {
  const candidates = [
    session?.queuePosition,
    session?.seatSetupInfo?.queuePosition,
    session?.sessionProgress?.queuePosition,
    session?.progressInfo?.queuePosition,
  ];
  for (const candidate of candidates) {
    const value = valueI64(candidate);
    if (value !== null && value > 0) return value;
  }
  return null;
}

function monitorDisplayData(hdr) {
  return {
    displayPrimaryX0: 0, displayPrimaryY0: 0, displayPrimaryX1: 0, displayPrimaryY1: 0,
    displayPrimaryX2: 0, displayPrimaryY2: 0, displayWhitePointX: 0, displayWhitePointY: 0,
    desiredContentMaxLuminance: hdr ? 1000 : 0,
    desiredContentMinLuminance: 0,
    desiredContentMaxFrameAverageLuminance: hdr ? 400 : 0,
  };
}

// ---------- リクエストボディ ----------

/** cloudmatch.rs:886-994 build_create_body の移植 */
export function buildCreateBody({ appId, params = {}, settings = {}, deviceHashId }) {
  const { width, height } = parseResolution(settings.resolution ?? '1920x1080');
  const fps = Math.min(240, Math.max(30, Number(settings.fps ?? 60)));
  const bitrate = Math.min(200, Math.max(1, Number(settings.maxBitrateMbps ?? 75))) * 1000;
  const codec = codecWire(settings.codec ?? 'auto');
  const hdr =
    Boolean(settings.enableHdr) &&
    Boolean(settings.nativeHdrSupported) &&
    (codec === 2 || codec === 3);
  const requestedColor = colorQualityWire(settings.colorQuality ?? '8bit_420');
  let bitDepth;
  let chroma;
  if (codec === 2 && hdr) [bitDepth, chroma] = [1, requestedColor[1]];
  else if (codec === 3 && hdr) [bitDepth, chroma] = [1, 0];
  else if (codec === 1) [bitDepth, chroma] = [0, 0];
  else if (codec === 3) [bitDepth, chroma] = [requestedColor[0], 0];
  else [bitDepth, chroma] = requestedColor;

  const cloudGsync = settings.nativeCloudGsyncMode === 'disabled'
    ? false
    : settings.nativeCloudGsyncMode === 'forced'
      ? true
      : Boolean(settings.enableCloudGsync ?? false);
  const reflex = cloudGsync || fps >= 120;
  const persistence =
    settings.enablePersistingInGameSettings !== false && params.supportsInGameSettingsPersistence === true;
  const physicalResolution = JSON.stringify({ horizontalPixels: width, verticalPixels: height });
  const clientPlatformName = settings.identifyAsSteamDeck ? 'SteamOS' : settings.clientPlatformName ?? 'Windows';

  const metadata = [
    { key: 'ClientImeSupport', value: '0' },
    { key: 'SubSessionId', value: randomUUID() },
    { key: 'clientPhysicalResolution', value: physicalResolution },
    { key: 'networkType', value: 'Unknown' },
    { key: 'wssignaling', value: '1' },
    { key: 'surroundAudioInfo', value: '2' },
  ];
  const features = {
    reflex,
    bitDepth,
    cloudGsync,
    enabledL4S: Boolean(settings.enableL4S ?? false),
    supportedHidDevices: 0,
    profile: 0,
    fallbackToLogicalResolution: false,
    chromaFormat: chroma,
    prefilterMode: 0,
    prefilterSharpness: 0,
    prefilterNoiseReduction: 0,
    hudStreamingMode: 0,
    codec,
    maxBitrateKbps: bitrate,
    vsync: false,
    audioChannelCount: 2,
    mouseMovementFlags: 0,
    trueHdr: hdr,
    hidDevices: null,
    qosPolicy: 0,
    touchSupport: false,
    dynamicStreamingMode: 0,
  };
  return {
    sessionRequestData: {
      appId: Number.parseInt(appId, 10) || 0,
      externalAppId: null,
      internalTitle: params.title ?? null,
      availableSupportedControllers: [2],
      preferredController: 2,
      networkTestSessionId: null,
      parentSessionId: null,
      clientIdentification: 'GFN-PC',
      deviceHashId,
      clientVersion: '30.0',
      sdkVersion: '2.0',
      streamerVersion: '14',
      clientPlatformName,
      clientRequestMonitorSettings: [{
        monitorId: 0, positionX: 0, positionY: 0,
        widthInPixels: width, heightInPixels: height, framesPerSecond: fps,
        sdrHdrMode: hdr ? 1 : 0,
        displayData: monitorDisplayData(hdr),
        hdr10PlusGamingData: null,
        dpi: 96,
      }],
      useOps: true,
      audioMode: 2,
      metaData: metadata,
      sdrHdrMode: hdr ? 1 : 0,
      clientDisplayHdrCapabilities: null,
      surroundAudioInfo: 0,
      remoteControllersBitmap: 0,
      clientTimezoneOffset: -new Date().getTimezoneOffset() * 60 * 1000,
      enhancedStreamMode: 0,
      appLaunchMode: appLaunchMode(params),
      secureRTSPSupported: true,
      partnerCustomData: null,
      accountLinked: params.accountLinked === true,
      enablePersistingInGameSettings: persistence,
      requestedAudioFormat: 0,
      userAge: 25,
      requestedStreamingFeatures: features,
      transport: null,
    },
  };
}

/** cloudmatch.rs:821-875 build_resume_body の移植(RESUMEはコーデック/解像度/FPSを再交渉しない) */
export function buildResumeBody({ appId, session, settings = {}, deviceHashId }) {
  const created = buildCreateBody({ appId, params: {}, settings, deviceHashId }).sessionRequestData;
  const keepKeys = [
    'appId', 'audioMode', 'remoteControllersBitmap', 'sdrHdrMode', 'networkTestSessionId',
    'availableSupportedControllers', 'preferredController', 'clientVersion', 'deviceHashId',
    'internalTitle', 'clientPlatformName', 'surroundAudioInfo', 'clientTimezoneOffset',
    'clientIdentification', 'parentSessionId', 'streamerVersion', 'secureRTSPSupported',
  ];
  const request = {};
  for (const key of keepKeys) request[key] = created[key];
  request.sdrHdrMode = acceptedHdrMode(session) ?? 0;
  request.metaData = (created.metaData ?? []).filter((entry) => entry.key !== 'clientPhysicalResolution');
  for (const key of ['appLaunchMode', 'enablePersistingInGameSettings', 'clientPlatformName']) {
    const value = session?.sessionRequestData?.[key];
    if (value !== null && value !== undefined) request[key] = value;
  }
  return { action: 2, data: 'RESUME', sessionRequestData: request, metaData: null, adUpdates: null };
}

function acceptedHdrMode(session) {
  const mode = valueI64(session?.sdrHdrMode ?? session?.sessionRequestData?.sdrHdrMode);
  return mode === 1 ? 1 : mode === 0 ? 0 : null;
}

// ---------- レスポンス検証 ----------

/** cloudmatch.rs:1290-1332 validate_cloudmatch_response */
function validateCloudmatchResponse(context, status, payload, { allowNotPaused = false } = {}) {
  const requestStatus = payload?.requestStatus;
  if (
    allowNotPaused &&
    status !== 401 && status !== 403 &&
    (valueI64(requestStatus?.statusCode) === 34 ||
      String(requestStatus?.statusDescription ?? '').includes('SESSION_NOT_PAUSED'))
  ) {
    return payload;
  }
  if (status < 200 || status >= 300) {
    const description = requestStatus?.statusDescription ?? payload?.message ?? payload?.error;
    throw new UpstreamError(
      status === 401 || status === 403 ? 'authentication_required' : 'session_error',
      `${context} (${status})${description ? `: ${description}` : ''}`,
      { status, payload },
    );
  }
  if (valueI64(requestStatus?.statusCode) !== 1) {
    const description = requestStatus?.statusDescription ?? 'CloudMatch rejected the request';
    const code = valueI64(requestStatus?.unifiedErrorCode) ?? valueI64(payload?.session?.errorCode);
    throw new UpstreamError('session_error', code !== null ? `${description} (${code})` : description, { payload });
  }
  return payload;
}

/** cloudmatch.rs:1333-1351 is_session_conflict */
function isSessionConflict(payload) {
  const rs = payload?.requestStatus;
  if (valueI64(rs?.statusCode) === 11) return true;
  if (String(rs?.statusDescription ?? '').toUpperCase().includes('SESSION_LIMIT')) return true;
  for (const code of [rs?.unifiedErrorCode, payload?.session?.errorCode]) {
    if (valueI64(code) === Number.parseInt(CONFLICT_ERROR_CODE, 16)) return true;
    if (typeof code === 'string' && code.replace(/^0x/, '').toUpperCase() === CONFLICT_ERROR_CODE) return true;
  }
  return false;
}

export class SessionConflictError extends Error {
  constructor(sessions) {
    super('A GeForce NOW session is already active. Resume it or end it before starting another game.');
    this.code = 'session_conflict';
    this.sessions = sessions;
  }
}

// ---------- セッション情報抽出 ----------

/** cloudmatch.rs:994-1140 session_info の移植 */
export function sessionInfo(payload, { fallbackBase, zone, fallbackAppId, deviceId }) {
  const session = payload?.session;
  const sessionId = typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : null;
  if (!sessionId) throw new UpstreamError('upstream_error', 'CloudMatch response did not include a session ID');
  const status = valueI64(session?.status) ?? 0;
  const connections = Array.isArray(session?.connectionInfo) ? session.connectionInfo : [];

  const signalingConnection =
    connections.find((c) => valueI64(c?.usage) === 14) ??
    connections.find((c) => typeof c?.ip === 'string') ??
    null;
  const controlHost = firstString(session?.sessionControlInfo?.ip);
  const serverIp =
    firstString(signalingConnection?.ip) ??
    (typeof signalingConnection?.resourcePath === 'string' ? hostFromResource(signalingConnection.resourcePath) : null) ??
    controlHost ??
    (() => { try { return new URL(fallbackBase).hostname; } catch { return ''; } })();
  const resource = typeof signalingConnection?.resourcePath === 'string' ? signalingConnection.resourcePath : '/nvst/';
  const signaling = signalingUrl(resource, serverIp);

  let controlBase;
  if (controlHost && isZoneHostname(controlHost)) {
    controlBase = `https://${controlHost.toLowerCase()}`;
  } else {
    const zoneBase = trustedCloudmatchBase(`https://${zone}`);
    controlBase = zoneBase ? zoneBase.origin : new URL(fallbackBase).origin;
  }

  const rtspsEndpoints = connections
    .filter((c) =>
      valueI64(c?.usage) === 16 ||
      valueI64(c?.appLevelProtocol) === 6 ||
      (typeof c?.resourcePath === 'string' && (c.resourcePath.startsWith('rtsps://') || c.resourcePath.startsWith('rtsp://'))))
    .map((c) => {
      if (typeof c.resourcePath === 'string' && (c.resourcePath.startsWith('rtsps://') || c.resourcePath.startsWith('rtsp://'))) {
        return c.resourcePath;
      }
      const host = firstString(c.ip);
      if (!host) return null;
      return `rtsps://${host}:${valueI64(c.port) ?? 322}`;
    })
    .filter(Boolean);

  const mediaConn = connections.find((c) => [2, 17].includes(valueI64(c?.usage)));
  let mediaConnectionInfo = null;
  if (mediaConn) {
    const ip = firstString(mediaConn.ip) ??
      (typeof mediaConn.resourcePath === 'string' ? hostFromResource(mediaConn.resourcePath) : null);
    const port = valueI64(mediaConn.port);
    if (ip && port && port > 0) mediaConnectionInfo = { ip, port, usage: valueI64(mediaConn.usage) };
  }

  const monitor = session?.sessionRequestData?.clientRequestMonitorSettings?.[0] ?? {};
  const features = { ...(session?.sessionRequestData?.requestedStreamingFeatures ?? {}) };
  Object.assign(features, session?.finalizedStreamingFeatures ?? {});
  const codecReported = session?.negotiatedStreamProfile?.codec !== undefined || features.codec !== undefined;
  const negotiated = {
    resolution: Number.isFinite(monitor.widthInPixels) && Number.isFinite(monitor.heightInPixels)
      ? `${monitor.widthInPixels}x${monitor.heightInPixels}`
      : null,
    fps: Number.isFinite(monitor.framesPerSecond) ? monitor.framesPerSecond : null,
    maxBitrateKbps: features.maxBitrateKbps ?? null,
    codec: null,
    codecSource: codecReported ? 'server' : 'unreported',
  };
  const serverCodec = session?.negotiatedStreamProfile?.codec;
  if (typeof serverCodec === 'string') {
    negotiated.codec = { H264: 'H264', AVC: 'H264', H265: 'H265', HEVC: 'H265', AV1: 'AV1' }[serverCodec.trim().toUpperCase()] ?? null;
  } else if (typeof features.codec === 'number') {
    negotiated.codec = codecFromWire(features.codec);
  }
  negotiated.enableHdr = acceptedHdrMode(session) === 1;

  const ads = Array.isArray(session?.sessionAds) ? session.sessionAds : [];
  const adState = ads.length > 0
    ? { active: true, ads: ads.map((ad) => ({ adId: firstString(ad?.adId), ...ad })) }
    : { active: false, ads: [] };

  return {
    sessionId,
    subSessionId: session?.subSessionId ?? null,
    appId: firstString(session?.sessionRequestData?.appId) ?? fallbackAppId ?? '0',
    status,
    phase: sessionPhase(status),
    queuePosition: queuePosition(session),
    seatSetupStep: valueI64(session?.seatSetupInfo?.seatSetupStep),
    adState,
    zone,
    streamingBaseUrl: controlBase,
    serverIp: serverIp ?? '',
    signalingServer: String(serverIp ?? '').includes(':') ? serverIp : `${serverIp}:443`,
    signalingUrl: signaling,
    serverLocation: session?.serverLocation ?? null,
    gpuType: session?.gpuType ?? null,
    appLaunchMode: session?.sessionRequestData?.appLaunchMode ?? null,
    enablePersistingInGameSettings: session?.sessionRequestData?.enablePersistingInGameSettings ?? false,
    connectionInfo: connections,
    rtspsEndpoints,
    iceServers: normalizeIceServers(session),
    mediaConnectionInfo,
    negotiatedStreamProfile: negotiated,
    requestedStreamingFeatures: session?.sessionRequestData?.requestedStreamingFeatures ?? null,
    finalizedStreamingFeatures: session?.finalizedStreamingFeatures ?? null,
    clientPlatformName: session?.sessionRequestData?.clientPlatformName ?? null,
  };
}

function remoteSessionInfo(session, base) {
  // 競合セッションの簡易抽出(cloudmatch.rs:1449-1495)
  const connections = Array.isArray(session?.connectionInfo) ? session.connectionInfo : [];
  const signalingConnection = connections.find((c) => valueI64(c?.usage) === 14) ?? connections.find((c) => typeof c?.ip === 'string');
  const serverIp = firstString(signalingConnection?.ip) ??
    (typeof signalingConnection?.resourcePath === 'string' ? hostFromResource(signalingConnection.resourcePath) : null);
  const monitor = session?.sessionRequestData?.clientRequestMonitorSettings?.[0] ?? {};
  return {
    sessionId: session?.sessionId ?? null,
    appId: firstString(session?.sessionRequestData?.appId),
    status: valueI64(session?.status) ?? 0,
    phase: sessionPhase(valueI64(session?.status) ?? 0),
    serverIp: serverIp ?? null,
    streamingBaseUrl: base?.origin ?? base ?? null,
    resolution: Number.isFinite(monitor.widthInPixels) ? `${monitor.widthInPixels}x${monitor.heightInPixels}` : null,
  };
}

// ---------- HTTP呼び出し ----------

async function getWithRetry(url, headers, context) {
  let lastError = null;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const result = await fetchJson(url, { headers }).catch((error) => {
      lastError = error;
      return null;
    });
    if (result) {
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(result.status);
      if (attempt < 2 && retryable) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
        continue;
      }
      return validateCloudmatchResponse(context, result.status, result.payload, {});
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
  }
  throw lastError ?? new UpstreamError('network_error', context);
}

/** create時に既定ホストをリージョン基へ解決(cloudmatch.rs:717-751 resolve_create_base) */
async function resolveCreateBase(requested, token, deviceHashId) {
  if (requested.hostname !== 'prod.cloudmatchbeta.nvidiagrid.net') return requested;
  try {
    const url = new URL('v2/serverInfo', requested.href);
    const result = await fetchJson(url, { headers: lcarsHeaders(token, { clientType: 'NATIVE', streamer: 'NVIDIA-CLASSIC' }) });
    if (!result.ok) return requested;
    const regional = regionalBases(result.payload).find((base) => !base.hostname.startsWith('np-'));
    return regional ?? requested;
  } catch {
    return requested;
  }
}

/**
 * セッション作成(cloudmatch.rs:57-155 create)
 * @returns {{info: object, base: URL, zone: string}}
 */
export async function createSession({ appId, params = {}, settings = {}, token, deviceHashId, providerBase }) {
  if (!/^\d+$/.test(String(appId ?? ''))) {
    throw new UpstreamError('invalid_params', 'The selected game launch app ID must be numeric');
  }
  const requested = trustedCloudmatchBase(providerBase || DEFAULT_STREAMING_URL);
  if (!requested) throw new UpstreamError('invalid_params', `Untrusted streaming service URL: ${providerBase}`);
  const base = await resolveCreateBase(requested, token, deviceHashId);
  const keyboardLayout = settings.keyboardLayout ?? 'en-US';
  const language = settings.gameLanguage ?? 'en_US';
  const url = new URL('v2/session', base.href);
  url.searchParams.set('keyboardLayout', keyboardLayout);
  url.searchParams.set('languageCode', language);
  const body = buildCreateBody({ appId, params, settings, deviceHashId });
  const headers = cloudmatchHeaders(token, deviceHashId);
  const result = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) });

  // セッション競合(既存セッションあり)
  if (result.status !== 401 && isSessionConflict(result.payload)) {
    const others = [
      ...(Array.isArray(result.payload?.otherUserSessions) ? result.payload.otherUserSessions : []),
      ...(result.payload?.session ? [result.payload.session] : []),
    ]
      .map((session) => remoteSessionInfo(session, base))
      .filter((s) => s.sessionId && s.appId && Number(s.appId) > 0 && s.serverIp && trustedLearnedServerBase(s.serverIp))
      .slice(0, 32);
    throw new SessionConflictError(others);
  }
  const payload = validateCloudmatchResponse('Session creation failed', result.status, result.payload, {});
  const zone = params.zone ?? base.hostname;
  const info = sessionInfo(payload, { fallbackBase: base.href, zone, fallbackAppId: appId, deviceId: deviceHashId });
  info.keyboardLayout = keyboardLayout;
  const requestCodec = codecFromWire(body.sessionRequestData.requestedStreamingFeatures.codec);
  if (!info.negotiatedStreamProfile.codec && requestCodec) {
    info.negotiatedStreamProfile.codec = requestCodec;
    info.negotiatedStreamProfile.codecSource = 'request';
  }

  // 互換性RESUME PUT(古いCloudMatchプール向け。失敗してもポーリング可能なので無視 — cloudmatch.rs:118-152)
  if (info.sessionId) {
    try {
      const resumeUrl = new URL(`v2/session/${info.sessionId}`, base.href);
      resumeUrl.searchParams.set('keyboardLayout', keyboardLayout);
      resumeUrl.searchParams.set('languageCode', language);
      const hdr = acceptedHdrMode(payload?.session);
      const resumeBody = buildResumeBody({ appId, session: payload.session, settings, deviceHashId });
      if (hdr !== null) {
        resumeBody.sessionRequestData.sdrHdrMode = hdr;
        resumeBody.sessionRequestData.clientRequestMonitorSettings[0].sdrHdrMode = hdr;
        resumeBody.sessionRequestData.clientRequestMonitorSettings[0].displayData = monitorDisplayData(hdr === 1);
        resumeBody.sessionRequestData.requestedStreamingFeatures.trueHdr = hdr === 1;
      }
      await fetchJson(resumeUrl, { method: 'PUT', headers, body: JSON.stringify(resumeBody) });
    } catch {
      /* 互換性目的のため失敗は無視 */
    }
  }
  return { info, base, zone };
}

/** セッションポーリング(cloudmatch.rs:157-233 poll) */
export async function pollSession({ state, token, deviceHashId }) {
  if (!state?.sessionId) throw new UpstreamError('invalid_params', 'No active session');
  const controlBase = state.controlBase;
  let base;
  if (state.serverIp && controlBase?.includes(state.serverIp)) {
    base = trustedLearnedServerBase(state.serverIp) ?? trustedCloudmatchBase(controlBase);
  } else {
    base = trustedCloudmatchBase(controlBase);
  }
  if (!base) throw new UpstreamError('invalid_params', 'No active session control endpoint');
  const headers = cloudmatchHeaders(token, deviceHashId);
  const url = new URL(`v2/session/${state.sessionId}`, base.href);
  const payload = await getWithRetry(url, headers, 'Session polling failed');
  let info = sessionInfo(payload, { fallbackBase: base.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });

  // ゾーン基でstatus 2/3になったら、学習したserverIp直アドレスで再取得(cloudmatch.rs:196-215)
  if (
    [2, 3].includes(info.status) &&
    isZoneHostname(base.hostname) &&
    info.serverIp &&
    !isZoneHostname(info.serverIp)
  ) {
    const direct = trustedLearnedServerBase(info.serverIp);
    if (direct) {
      try {
        const directUrl = new URL(`v2/session/${state.sessionId}`, direct.href);
        const directPayload = await getWithRetry(directUrl, headers, 'Session polling failed');
        const directInfo = sessionInfo(directPayload, { fallbackBase: direct.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });
        if (!directInfo.negotiatedStreamProfile.codec && info.negotiatedStreamProfile.codec) {
          directInfo.negotiatedStreamProfile = { ...directInfo.negotiatedStreamProfile, codec: info.negotiatedStreamProfile.codec, codecSource: info.negotiatedStreamProfile.codecSource };
        }
        info = directInfo;
      } catch {
        /* ゾーン基の結果を維持 */
      }
    }
  }
  if (state.resumePending) {
    const ready = [2, 3].includes(info.status) && (info.rtspsEndpoints?.length ?? 0) > 0;
    if (![1, 2, 3, 4, 5, 6].includes(info.status)) {
      info.resumePending = false;
      info.phase = 'failed';
    } else {
      info.resumePending = !ready;
      if (!ready) info.phase = 'resuming';
    }
  }
  return info;
}

/** 既存セッションのclaim/resume(cloudmatch.rs:477-570) */
export async function claimSession({ sessionId, state, settings = {}, token, deviceHashId, providerBase }) {
  const requested = trustedCloudmatchBase(providerBase || DEFAULT_STREAMING_URL) ?? new URL(DEFAULT_STREAMING_URL);
  const lookupBase = (state?.serverIp && trustedLearnedServerBase(state.serverIp)) ?? requested;
  const headers = cloudmatchHeaders(token, deviceHashId);
  const payload = await getWithRetry(new URL(`v2/session/${sessionId}`, lookupBase.href), headers, 'Session claim failed');
  const session = payload?.session;
  const initialStatus = valueI64(session?.status) ?? 0;
  if (![1, 2, 3, 4, 5, 6].includes(initialStatus)) {
    throw new UpstreamError('session_error', 'This GeForce NOW session is no longer resumable. End it and launch again.');
  }
  const learnedServer = firstString(session?.connectionInfo?.find((c) => valueI64(c?.usage) === 14)?.ip ?? null) ??
    firstString(session?.sessionControlInfo?.ip);
  const controlBase = (learnedServer && trustedLearnedServerBase(learnedServer)) ?? lookupBase;
  const appId = firstString(session?.sessionRequestData?.appId) ?? '0';
  const keyboardLayout = settings.keyboardLayout ?? state?.keyboardLayout ?? 'en-US';
  const language = settings.gameLanguage ?? 'en_US';
  const resumed = initialStatus >= 2 && initialStatus <= 5;
  if (resumed) {
    const url = new URL(`v2/session/${sessionId}`, controlBase.href);
    url.searchParams.set('keyboardLayout', keyboardLayout);
    url.searchParams.set('languageCode', language);
    const body = buildResumeBody({ appId, session, settings, deviceHashId });
    const result = await fetchJson(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    validateCloudmatchResponse('Session claim failed', result.status, result.payload, { allowNotPaused: true });
  }
  const info = sessionInfo(payload, { fallbackBase: controlBase.href, zone: controlBase.hostname, fallbackAppId: appId, deviceId: deviceHashId });
  info.keyboardLayout = keyboardLayout;
  info.resumePending = true;
  info.phase = 'resuming';
  return { info, controlBase };
}

/** セッション停止(cloudmatch.rs:235-315 stop)。404は成功扱い */
export async function stopSession({ state, token, deviceHashId }) {
  if (!state?.sessionId) return { stopped: false };
  let base = null;
  if (state.serverIp && !isZoneHostname(state.serverIp)) base = trustedLearnedServerBase(state.serverIp);
  if (!base) base = trustedCloudmatchBase(state.controlBase ?? DEFAULT_STREAMING_URL);
  if (!base) return { stopped: false };
  const url = new URL(`v2/session/${state.sessionId}`, base.href);
  const result = await fetchJson(url, { method: 'DELETE', headers: cloudmatchHeaders(token, deviceHashId) });
  if (!(result.status >= 200 && result.status < 300) && result.status !== 404) {
    const description = result.payload?.requestStatus?.statusDescription;
    throw new UpstreamError('session_error', `Session stop failed (${result.status})${description ? `: ${description}` : ''}`);
  }
  return { stopped: true, sessionId: state.sessionId };
}

/** 広告状態レポート(cloudmatch.rs:568-640 report_ad)— 無料枠の広告フロー用 */
export async function reportAd({ state, params, token, deviceHashId }) {
  if (!state?.sessionId) throw new UpstreamError('invalid_params', 'No active session');
  const actionMap = { start: 1, pause: 2, resume: 3, finish: 4, cancel: 5 };
  const action = actionMap[params?.action];
  if (!action) throw new UpstreamError('invalid_params', 'Unknown session ad action');
  const adId = params?.adId;
  if (typeof adId !== 'string' || adId === '') throw new UpstreamError('invalid_params', 'adId is required');
  let base = null;
  if (state.serverIp) base = trustedLearnedServerBase(state.serverIp);
  if (!base) base = trustedCloudmatchBase(state.controlBase);
  if (!base) throw new UpstreamError('invalid_params', 'No active session control endpoint');
  const update = {
    adId,
    adAction: action,
    clientTimestamp: Number(params.clientTimestamp ?? Math.floor(Date.now() / 1000)),
  };
  for (const key of ['watchedTimeInMs', 'pausedTimeInMs']) {
    if (Number.isFinite(Number(params[key]))) update[key] = Math.max(0, Number(params[key]));
  }
  if (typeof params.cancelReason === 'string') update.cancelReason = params.cancelReason;
  const url = new URL(`v2/session/${state.sessionId}`, base.href);
  const result = await fetchJson(url, {
    method: 'PUT',
    headers: cloudmatchHeaders(token, deviceHashId),
    body: JSON.stringify({ action: 6, adUpdates: [update] }),
  });
  const payload = validateCloudmatchResponse('Session ad update failed', result.status, result.payload, {});
  return sessionInfo(payload, { fallbackBase: base.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });
}
