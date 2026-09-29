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
/** 作成直後のpoll 404を「伝播待ち」とみなす猶予(ms) */
const SESSION_PROPAGATION_GRACE_MS = 20_000;

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

/**
 * Web(WebRTC)セッション作成ボディ
 * 出典: OpenNOW v0.5.5 cloudmatchSessionRequest.ts buildSessionRequestBody +
 *       cloudmatchFeatures.ts buildRequestedStreamingFeatures
 * 重要な差分(Rustネイティブ版と混同しないこと):
 *   sdkVersion "1.0" / streamerVersion 1(数値)/ secureRTSPSupported false /
 *   enhancedStreamMode 1 / metaData に GSStreamerType=WebRTC /
 *   availableSupportedControllers [] / dpi 0 / dynamicStreamingMode 3 /
 *   accountLinked 既定 true / userAge 26 / partnerCustomData ""
 * → これにより CloudMatch は ICE/TURN 構成と /nvst/ Webシグナリングを持つ
 *   WebRTCセッションをプロビジョンする(ネイティブ仕様だと rtsps エンドポイントの
 *   みのセッションが返り、ブラウザでは接続不能 — 2026-09-29 実測で確認)
 */
export function buildCreateBody({ appId, params = {}, settings = {}, deviceHashId }) {
  const { width, height } = parseResolution(settings.resolution ?? '1920x1080');
  const fps = Math.min(240, Math.max(30, Number(settings.fps ?? 60)));
  const bitrate = Math.min(200, Math.max(1, Number(settings.maxBitrateMbps ?? 75))) * 1000;
  // Web版は H264 既定(ブラウザのHWデコード互換性重視)。auto(0)はサーバーが
  // HEVC/AV1を選ぶ可能性があり、Chrome環境次第で黒画面になるため既定にしない
  const codec = codecWire(settings.codec ?? 'h264');
  // HDRはElectron版同様ハードコードOFF(10bit colorQuality と HDR は別トグル。
  // 混同するとサーバーがHDRパイプラインを構成し解像度が~540pに動的ダウンスケールされた実績あり)
  const hdr = false;
  const [reqBitDepth, reqChroma] = colorQualityWire(settings.colorQuality ?? '8bit_420');
  // H.264は8bit 4:2:0のみ(Rust版と同じ制約)
  const bitDepth = codec === 1 ? 0 : reqBitDepth;
  const chromaFormat = codec === 1 ? 0 : reqChroma;

  const cloudGsync = settings.nativeCloudGsyncMode === 'disabled'
    ? false
    : settings.nativeCloudGsyncMode === 'forced'
      ? true
      : Boolean(settings.enableCloudGsync ?? false);
  const reflex = cloudGsync || fps >= 120; // DEFAULT_MINIMUM_FPS_FOR_REFLEX_WITHOUT_VRR
  const persistence =
    params.enablePersistingInGameSettings === true && params.supportsInGameSettingsPersistence === true;
  const physicalResolution = JSON.stringify({ horizontalPixels: width, verticalPixels: height });
  const clientPlatformName = settings.identifyAsSteamDeck ? 'SteamOS' : 'windows';

  // webRtcSessionMetadata(cloudmatchSessionRequest.ts:33-47)— 順序も合わせる
  const metadata = [
    { key: 'SubSessionId', value: randomUUID() },
    { key: 'wssignaling', value: '1' },
    { key: 'GSStreamerType', value: 'WebRTC' },
    { key: 'networkType', value: 'Unknown' },
    { key: 'ClientImeSupport', value: '0' },
    { key: 'clientPhysicalResolution', value: physicalResolution },
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
    chromaFormat,
    prefilterMode: 0,
    prefilterSharpness: 0,
    prefilterNoiseReduction: 0,
    hudStreamingMode: 0,
    maxBitrateKbps: bitrate,
    codec,
    vsync: false,
    dynamicStreamingMode: 3,
    audioChannelCount: 2,
  };
  return {
    sessionRequestData: {
      appId: Number.parseInt(appId, 10) || 0,
      internalTitle: params.title ?? null,
      availableSupportedControllers: [],
      networkTestSessionId: null,
      parentSessionId: null,
      clientIdentification: 'GFN-PC',
      deviceHashId,
      clientVersion: '30.0',
      sdkVersion: '1.0',
      streamerVersion: 1,
      clientPlatformName,
      clientRequestMonitorSettings: [{
        monitorId: 0, positionX: 0, positionY: 0,
        widthInPixels: width, heightInPixels: height, framesPerSecond: fps,
        sdrHdrMode: 0,
        displayData: {},
        hdr10PlusGamingData: null,
        dpi: 0,
      }],
      useOps: true,
      audioMode: 2,
      metaData: metadata,
      sdrHdrMode: 0,
      clientDisplayHdrCapabilities: null,
      surroundAudioInfo: 0,
      remoteControllersBitmap: 0,
      clientTimezoneOffset: -new Date().getTimezoneOffset() * 60 * 1000,
      enhancedStreamMode: 1,
      appLaunchMode: appLaunchMode(params),
      secureRTSPSupported: false,
      partnerCustomData: '',
      accountLinked: params.accountLinked !== false,
      enablePersistingInGameSettings: persistence,
      userAge: 26,
      requestedStreamingFeatures: features,
    },
  };
}

/**
 * claim/RESUMEボディ — Electron buildClaimRequestBody(cloudmatchSessionRequest.ts:136-199)準拠。
 * RESUMEではストリーミングパラメータを再交渉しない(送るとHTTP 400)。最小フィールドのみ。
 */
export function buildResumeBody({ appId, session, settings = {}, deviceHashId }) {
  return {
    action: 2,
    data: 'RESUME',
    sessionRequestData: {
      audioMode: 2,
      remoteControllersBitmap: 0,
      sdrHdrMode: 0,
      networkTestSessionId: null,
      availableSupportedControllers: [],
      clientVersion: '30.0',
      deviceHashId,
      internalTitle: null,
      clientPlatformName: settings.identifyAsSteamDeck ? 'SteamOS' : 'windows',
      metaData: [
        { key: 'SubSessionId', value: randomUUID() },
        { key: 'wssignaling', value: '1' },
        { key: 'GSStreamerType', value: 'WebRTC' },
        { key: 'networkType', value: 'Unknown' },
        { key: 'ClientImeSupport', value: '0' },
        { key: 'surroundAudioInfo', value: '2' },
      ],
      surroundAudioInfo: 0,
      clientTimezoneOffset: -new Date().getTimezoneOffset() * 60 * 1000,
      clientIdentification: 'GFN-PC',
      parentSessionId: null,
      appId: Number.parseInt(appId, 10) || 0,
      streamerVersion: 1,
      appLaunchMode: valueI64(session?.sessionRequestData?.appLaunchMode) ?? appLaunchMode(settings),
      sdkVersion: '1.0',
      enhancedStreamMode: 1,
      useOps: true,
      clientDisplayHdrCapabilities: null,
      accountLinked: true,
      partnerCustomData: '',
      enablePersistingInGameSettings: session?.sessionRequestData?.enablePersistingInGameSettings === true,
      secureRTSPSupported: false,
      userAge: 26,
    },
    metaData: [],
  };
}

function acceptedHdrMode(session) {
  const mode = valueI64(session?.sdrHdrMode ?? session?.sessionRequestData?.sdrHdrMode);
  return mode === 1 ? 1 : mode === 0 ? 0 : null;
}

// ---------- レスポンス検証 ----------

/**
 * 既知のCloudMatchセッションエラー(statusCode → 意味)
 * 出典: OpenNOW v0.5.5 gfnErrorCodeEnum.ts(statusCode定義)+ gfnErrorMessages.ts(公式メッセージ)
 */
const SESSION_ERROR_BY_STATUS = new Map([
  [10, ['request_limit', 'セッション要求が多すぎます(NVIDIAのレート制限)。5〜10分待ってから再試行してください']],
  [13, ['time_exceeded', 'セッションの権利時間(allotted time)を超過しました']],
  [19, ['invalid_app', 'このゲームは現在利用できません(appIdが無効/提供終了)']],
  [20, ['invalid_app', 'このゲームは現在利用できません(appIdが見つかりません)']],
  [23, ['eula', 'このゲームのEULA(使用許諾)への同意が必要です。公式クライアント/サイトで一度同意してください']],
  [24, ['maintenance', 'GeForce NOWサービスはメンテナンス中です']],
  [25, ['unavailable', 'サービスが一時的に利用できません']],
  [26, ['steam_login', 'Steam Guard認証が必要です。公式クライアントで一度ログインし直してください']],
  [27, ['steam_login', 'Steamログインが必要です。アカウント連携を確認してください']],
  [28, ['steam_login', 'Steam Guardコードが無効でした。公式クライアントでログインし直してください']],
  [41, ['app_patching', 'このゲームはNVIDIAサーバー側で更新(パッチ適用)中です。通常は数時間以内に再開されます。別のタイトルでお試しください']],
  [42, ['game_not_found', 'ゲームが見つかりません']],
  [49, ['session_expired', 'セッションの有効期限が切れました']],
  [51, ['capacity', '転送ゾーンが混雑しています(ForwardingZoneOutOfCapacity)']],
  [54, ['region_hold', 'このリージョンは無料枠を一時的に制限しています']],
  [55, ['region_hold', 'このリージョンは有料枠を一時的に制限しています']],
  [56, ['app_maintenance', 'このゲームはメンテナンス中です']],
  [58, ['capacity', 'サーバー容量が不足しています(混雑)。時間をおいて再試行してください']],
  [62, ['queue_full', '待機行列が上限に達しています。時間をおいて再試行してください']],
  [64, ['forward_expired', '転送リクエストの割り当て時間が切れました。再試行してください']],
  [65, ['forward_binaries', 'このリージョンにゲームバイナリがありません。別リージョンでお試しください']],
  [66, ['forward_binaries', 'このリージョンにゲームバイナリがありません。別リージョンでお試しください']],
  [69, ['queue_abandoned', '待機行列のリクエストがサーバー側で破棄されました(混雑/キュータイムアウト/遠隔リージョンの無料枠で発生しやすい)。自動再試行します。改善しない場合は日本など近いリージョンや別の時間帯をお試しください']],
  [85, ['capacity', '容量不足のためセッションが拒否されました(SessionRejectedNoCapacity)']],
  [91, ['not_allowed', 'このゲームはストリーミングが許可されていません']],
]);

/** statusDescription 文字列からの種別推定(statusCodeが返らない場合のフォールバック) */
const SESSION_ERROR_BY_DESCRIPTION = [
  [/APP_PATCHING|PATCHING_STATUS/i, 'app_patching', 'このゲームはNVIDIAサーバー側で更新(パッチ適用)中です。通常は数時間以内に再開されます。別のタイトルでお試しください'],
  [/APP_MAINTENANCE/i, 'app_maintenance', 'このゲームはメンテナンス中です'],
  [/MAINTENANCE/i, 'maintenance', 'サービスはメンテナンス中です'],
  [/STEAM_GUARD/i, 'steam_login', 'Steam Guard認証が必要です'],
  [/STEAM_LOGIN/i, 'steam_login', 'Steamログインが必要です'],
  [/EULA/i, 'eula', 'EULAへの同意が必要です'],
  [/QUEUE_LENGTH_EXCEEDED/i, 'queue_full', '待機行列が上限に達しています'],
  [/IN_QUEUE_ABANDONED|QUEUE_ABANDONED/i, 'queue_abandoned', '待機行列のリクエストがサーバー側で破棄されました(混雑/キュータイムアウト)。自動再試行します'],
  [/CAPACITY/i, 'capacity', 'サーバーが混雑しています'],
  [/REQUEST_LIMIT_EXCEEDED|REQUEST_LIMIT/i, 'request_limit', 'セッション要求が多すぎます(NVIDIAのレート制限)。5〜10分待ってから再試行してください'],
];

/**
 * CloudMatchエラーの機械可読種別+日本語メッセージを解決する
 * @returns {{kind: string, messageJa: string}|null}
 */
export function describeSessionError({ statusCode = null, description = '', unifiedErrorCode = null } = {}) {
  const code = valueI64(statusCode);
  if (code !== null && SESSION_ERROR_BY_STATUS.has(code)) {
    const [kind, messageJa] = SESSION_ERROR_BY_STATUS.get(code);
    return { kind, messageJa };
  }
  const text = `${description ?? ''} ${unifiedErrorCode ?? ''}`;
  for (const [pattern, kind, messageJa] of SESSION_ERROR_BY_DESCRIPTION) {
    if (pattern.test(text)) return { kind, messageJa };
  }
  return null;
}

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
  const known = describeSessionError({
    statusCode: requestStatus?.statusCode ?? null,
    description: requestStatus?.statusDescription ?? '',
    unifiedErrorCode: requestStatus?.unifiedErrorCode ?? payload?.session?.errorCode ?? null,
  });
  if (status < 200 || status >= 300) {
    const description = requestStatus?.statusDescription ?? payload?.message ?? payload?.error;
    const message = known
      ? known.messageJa
      : `${context} (${status})${description ? `: ${description}` : ''}`;
    throw new UpstreamError(
      status === 401 || status === 403 ? 'authentication_required' : 'session_error',
      message,
      { status, payload, kind: known?.kind ?? null },
    );
  }
  if (valueI64(requestStatus?.statusCode) !== 1) {
    const description = requestStatus?.statusDescription ?? 'CloudMatch rejected the request';
    const code = valueI64(requestStatus?.unifiedErrorCode) ?? valueI64(payload?.session?.errorCode);
    const message = known
      ? known.messageJa
      : code !== null
        ? `${description} (${code})`
        : description;
    throw new UpstreamError('session_error', message, { payload, kind: known?.kind ?? null });
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
  // normalize_ad_state(cloudmatch.rs:1143-1168)+ Electron shared/gfn/session.ts の
  // SessionAdState 型に準拠。serverSentEmptyAds は「サーバーが sessionAds=null を返した」
  // 目印(広告リストは作成直後の1回目のpollでしか送られてこない — queueAds.ts mergeAdState)
  const required =
    session?.sessionAdsRequired === true ||
    session?.isAdsRequired === true ||
    session?.sessionProgress?.isAdsRequired === true ||
    (session?.sessionAdsRequired === undefined &&
      session?.isAdsRequired === undefined &&
      session?.sessionProgress?.isAdsRequired === undefined &&
      ads.length > 0);
  const opportunity = session?.opportunity ?? null;
  const adState =
    !required && ads.length === 0 && opportunity === null
      ? null
      : {
          isAdsRequired: required,
          sessionAdsRequired: required,
          serverSentEmptyAds: session?.sessionAds === null || session?.sessionAds === undefined,
          isQueuePaused: opportunity?.queuePaused === true,
          gracePeriodSeconds: opportunity?.gracePeriodSeconds ?? null,
          message: opportunity?.message ?? opportunity?.description ?? null,
          opportunity,
          sessionAds: ads,
        };

  return {
    sessionId,
    subSessionId: session?.subSessionId ?? null,
    appId: firstString(session?.sessionRequestData?.appId) ?? fallbackAppId ?? '0',
    status,
    phase: sessionPhase(status),
    queuePosition: queuePosition(session),
    seatSetupStep: valueI64(session?.seatSetupInfo?.seatSetupStep),
    // isGfnSessionInQueue(shared/gfn/session.ts:279-284)
    inQueue: valueI64(session?.seatSetupInfo?.seatSetupStep) === 1 || (queuePosition(session) ?? 0) > 1,
    readyForConnect: status === 2 || status === 3,
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
 * 起動時のリージョン指定を解決する。
 * region が指定されれば信頼検証のうえそれを使い(明示指定時は resolveCreateBase を
 * 経由せず直接そのゾーン基にPOSTする — Electron版 settings.region と同じ挙動、
 * cloudmatch.rs:765-787 requested_streaming_base + 717-721)、
 * 無ければプロバイダ既定基を返す。
 */
export function resolveRequestedRegion(region, providerBase) {
  if (typeof region === 'string' && region.trim() !== '' && region.trim() !== 'auto') {
    const base = trustedCloudmatchBase(region.trim());
    if (!base) {
      throw new UpstreamError('invalid_params', `Untrusted region URL: ${region}`);
    }
    return base.href;
  }
  return providerBase;
}

/**
 * 残留セッションのベストエフォート掃除。
 * 前回テストのキュー残り(status=1)や自デバイス(deviceHashId一致)のセッションは
 * 新しいキューリクエストの abandoned/競合を誘発するため、作成前に DELETE する。
 * 他デバイスのストリーミング中(status 2/3)セッションは絶対に触らない。
 */
export async function cleanupStaleSessions({ bases, token, deviceHashId }) {
  const headers = cloudmatchHeaders(token, deviceHashId, { includeOrigin: false });
  const removed = [];
  for (const baseUrl of bases) {
    if (!baseUrl) continue;
    try {
      const result = await fetchJson(new URL('v2/session', baseUrl), { headers });
      if (!result.ok) continue;
      const sessions = Array.isArray(result.payload?.sessions) ? result.payload.sessions : [];
      for (const sess of sessions) {
        const sid = sess?.sessionId;
        if (typeof sid !== 'string' || sid === '') continue;
        const status = valueI64(sess?.status) ?? 0;
        const sameDevice = sess?.sessionRequestData?.deviceHashId === deviceHashId;
        if (!(status === 1 || sameDevice)) continue; // キュー残り or 自デバイスのみ
        try {
          await fetchJson(new URL(`v2/session/${sid}`, baseUrl), { method: 'DELETE', headers });
          removed.push({ sessionId: sid, status, sameDevice });
        } catch {
          /* 個別削除失敗は無視 */
        }
      }
    } catch {
      /* 一覧取得失敗は無視(ベースごとにベストエフォート) */
    }
  }
  return removed;
}

/**
 * セッション作成(cloudmatch.rs:57-155 create)
 * @returns {{info: object, base: URL, zone: string, clientId: string, cleanedUp: Array}}
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
  const clientId = randomUUID(); // Electron: セッション単位で安定した clientId
  const headers = cloudmatchHeaders(token, deviceHashId, { clientId, includeOrigin: true });
  const zone = params.zone ?? base.hostname;

  // 作成前の残留掃除(ベストエフォート): キュー残り/自デバイス旧セッションを DELETE
  const cleanupBases = [base.href];
  if (DEFAULT_STREAMING_URL !== base.href) cleanupBases.push(DEFAULT_STREAMING_URL);
  const cleaned = await cleanupStaleSessions({ bases: cleanupBases, token, deviceHashId });

  // CloudMatchは既存セッションがある場合、要求と異なるappIdのセッションを
  // 「静かに再利用」して返すことがある(2026-09-29実測: 103500271要求→102241311応答)。
  // その場合は古いセッションを破棄して1回だけ再作成する。
  let info = null;
  let body = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    body = buildCreateBody({ appId, params, settings, deviceHashId });
    const result = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) });

    // セッション競合(明示的な競合応答)
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
    info = sessionInfo(payload, { fallbackBase: base.href, zone, fallbackAppId: appId, deviceId: deviceHashId });
    info.keyboardLayout = keyboardLayout;
    info.clientId = clientId;
    if (!info.negotiatedStreamProfile.codec) {
      info.negotiatedStreamProfile.codec = codecFromWire(body.sessionRequestData.requestedStreamingFeatures.codec);
      info.negotiatedStreamProfile.codecSource = 'request';
    }
    if (attempt === 0 && String(info.appId) !== String(Number(appId))) {
      // 別ゲームのセッションが返された → 破棄して再作成
      try {
        await fetchJson(new URL(`v2/session/${info.sessionId}`, base.href), { method: 'DELETE', headers });
      } catch {
        /* 破棄失敗でも再作成は試行 */
      }
      continue;
    }
    break;
  }
  if (String(info.appId) !== String(Number(appId))) {
    info.reusedStaleSession = true; // フロントで警告表示用
  }
  // 注意: Rustネイティブ版にあった「作成直後の互換RESUME PUT」はWebセッションでは送らない
  // (Electron版createにも存在せず、Webセッションの状態機械を乱す可能性があるため)
  return { info, base, zone, clientId, cleanedUp: cleaned };
}

/**
 * セッションポーリング(cloudmatch.rs:157-233 poll + 404フォールバック拡張)
 * 作成基とセッション制御基が食い違う場合(リージョン間転送など)に
 * INVALID_SESSION_ID_NOT_FOUND(404) になるため、複数の候補基を順に試す。
 * 成功した基は effectiveBase として返し、routes 側が state.pollBase に保存する。
 * @returns {{info: object, effectiveBase: string}}
 */
export async function pollSession({ state, token, deviceHashId }) {
  if (!state?.sessionId) throw new UpstreamError('invalid_params', 'No active session');
  const headers = cloudmatchHeaders(token, deviceHashId, { clientId: state.clientId, includeOrigin: false });

  const candidates = [];
  const push = (url) => {
    if (url && !candidates.some((c) => c.href === url.href)) candidates.push(url);
  };
  if (state.pollBase) push(trustedCloudmatchBase(state.pollBase) ?? trustedLearnedServerBase(state.pollBase));
  if (state.serverIp && state.controlBase?.includes(state.serverIp)) push(trustedLearnedServerBase(state.serverIp));
  push(trustedCloudmatchBase(state.controlBase));
  if (state.requestedBase) push(trustedCloudmatchBase(state.requestedBase));
  if (state.serverIp) push(trustedLearnedServerBase(state.serverIp));
  if (state.zone) push(trustedCloudmatchBase(`https://${state.zone}`));
  if (candidates.length === 0) throw new UpstreamError('invalid_params', 'No active session control endpoint');

  let lastError = null;
  let allNotFound = true;
  for (const base of candidates) {
    let payload;
    try {
      payload = await getWithRetry(new URL(`v2/session/${state.sessionId}`, base.href), headers, 'Session polling failed');
    } catch (error) {
      lastError = error;
      // 404(INVALID_SESSION_ID_NOT_FOUND)なら次の候補基へ。それ以外は即失敗
      const notFound = error instanceof UpstreamError && error.status === 404;
      if (notFound) continue;
      throw error;
    }
    allNotFound = false;
    let info = sessionInfo(payload, { fallbackBase: base.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });
    // ゾーン基でstatus 2/3になったら、学習したserverIp直アドレスで再取得(cloudmatch.rs:196-215)
    if ([2, 3].includes(info.status) && isZoneHostname(base.hostname) && info.serverIp && !isZoneHostname(info.serverIp)) {
      const direct = trustedLearnedServerBase(info.serverIp);
      if (direct) {
        try {
          const directPayload = await getWithRetry(new URL(`v2/session/${state.sessionId}`, direct.href), headers, 'Session polling failed');
          const directInfo = sessionInfo(directPayload, { fallbackBase: direct.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });
          if (!directInfo.negotiatedStreamProfile.codec && info.negotiatedStreamProfile.codec) {
            directInfo.negotiatedStreamProfile = { ...directInfo.negotiatedStreamProfile, codec: info.negotiatedStreamProfile.codec, codecSource: info.negotiatedStreamProfile.codecSource };
          }
          info = directInfo;
          return { info, effectiveBase: direct.href };
        } catch {
          /* ゾーン基の結果を維持 */
        }
      }
    }
    if (state.resumePending) {
      const ready = [2, 3].includes(info.status) && (info.rtspsEndpoints?.length ?? 0) > 0 || [2, 3].includes(info.status) && info.signalingUrl;
      if (![1, 2, 3, 4, 5, 6].includes(info.status)) {
        info.resumePending = false;
        info.phase = 'failed';
      } else {
        info.resumePending = !ready;
        if (!ready) info.phase = 'resuming';
      }
    }
    return { info, effectiveBase: base.href };
  }

  // 全候補基が404:
  if (allNotFound) {
    // (a) 作成直後は伝播待ちの可能性があるため猶予期間内は transient 扱いで polling を続行
    //     (2026-09-29実測: 作成0.5秒後の初回pollが全基404 → 即410で誤キックの事例)
    const ageMs = Number.isFinite(state.createdAt) ? Date.now() - Number(state.createdAt) : Infinity;
    if (ageMs < SESSION_PROPAGATION_GRACE_MS && state.info) {
      return { info: { ...state.info, pollTransient: true }, effectiveBase: null, transient: true };
    }
    // (b) LIST エンドポイントでセッションを探索(キュー転送で別ゾーンへ移動した場合、
    //     単一IDのGETは404でも一覧には現れる — OpenNOW remote_sessions と同じ発想)
    const listBases = [...candidates];
    const prodBase = trustedCloudmatchBase(DEFAULT_STREAMING_URL);
    if (prodBase && !listBases.some((c) => c.href === prodBase.href)) listBases.push(prodBase);
    for (const base of listBases) {
      try {
        const listResult = await fetchJson(new URL('v2/session', base.href), { headers });
        if (!listResult.ok) continue;
        const sessions = Array.isArray(listResult.payload?.sessions) ? listResult.payload.sessions : [];
        const entry = sessions.find((item) => item?.sessionId === state.sessionId);
        if (entry) {
          const info = sessionInfo({ session: entry }, {
            fallbackBase: base.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId,
          });
          return { info, effectiveBase: base.href };
        }
      } catch {
        /* 次の基へ */
      }
    }
  }
  const finalError = lastError ?? new UpstreamError('session_error', 'Session polling failed on all candidate bases');
  // 410判定の根拠をフロントの診断ログに渡す(猶予が効かなかった理由の確定用)
  finalError.debug = {
    createdAt: state.createdAt ?? null,
    ageMs: Number.isFinite(state.createdAt) ? Date.now() - Number(state.createdAt) : null,
    graceMs: SESSION_PROPAGATION_GRACE_MS,
    hadInfo: Boolean(state.info),
    triedBases: candidates.map((c) => c.href),
  };
  throw finalError;
}

/** 既存セッションのclaim/resume(cloudmatch.rs:477-570) */
export async function claimSession({ sessionId, state, settings = {}, token, deviceHashId, providerBase }) {
  const requested = trustedCloudmatchBase(providerBase || DEFAULT_STREAMING_URL) ?? new URL(DEFAULT_STREAMING_URL);
  const lookupBase = (state?.pollBase && trustedCloudmatchBase(state.pollBase)) ??
    (state?.serverIp && trustedLearnedServerBase(state.serverIp)) ?? requested;
  const headers = cloudmatchHeaders(token, deviceHashId, { clientId: state?.clientId, includeOrigin: true });
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
  if (state.pollBase) base = trustedCloudmatchBase(state.pollBase) ?? trustedLearnedServerBase(state.pollBase);
  if (!base && state.serverIp && !isZoneHostname(state.serverIp)) base = trustedLearnedServerBase(state.serverIp);
  if (!base) base = trustedCloudmatchBase(state.controlBase ?? DEFAULT_STREAMING_URL);
  if (!base) return { stopped: false };
  const url = new URL(`v2/session/${state.sessionId}`, base.href);
  const result = await fetchJson(url, { method: 'DELETE', headers: cloudmatchHeaders(token, deviceHashId, { clientId: state.clientId, includeOrigin: false }) });
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
  if (state.pollBase) base = trustedCloudmatchBase(state.pollBase) ?? trustedLearnedServerBase(state.pollBase);
  if (!base && state.serverIp) base = trustedLearnedServerBase(state.serverIp);
  if (!base) base = trustedCloudmatchBase(state.controlBase);
  if (!base) throw new UpstreamError('invalid_params', 'No active session control endpoint');
  const update = {
    adId,
    adAction: action,
    clientTimestamp: Number(params.clientTimestamp ?? Math.floor(Date.now() / 1000)),
  };
  for (const key of ['watchedTimeInMs', 'pausedTimeInMs']) {
    if (params[key] !== undefined && Number.isFinite(Number(params[key]))) update[key] = Math.max(0, Number(params[key]));
  }
  if (typeof params.cancelReason === 'string') update.cancelReason = params.cancelReason;
  if (typeof params.errorInfo === 'string') update.errorInfo = params.errorInfo;
  const url = new URL(`v2/session/${state.sessionId}`, base.href);
  const result = await fetchJson(url, {
    method: 'PUT',
    headers: cloudmatchHeaders(token, deviceHashId, { clientId: state.clientId, includeOrigin: false }),
    body: JSON.stringify({ action: 6, adUpdates: [update] }),
  });
  const payload = validateCloudmatchResponse('Session ad update failed', result.status, result.payload, {});
  return sessionInfo(payload, { fallbackBase: base.href, zone: state.zone, fallbackAppId: state.appId, deviceId: deviceHashId });
}


/**
 * poll間の広告リスト保持(queueAds.ts mergeAdState の移植)
 * サーバーは sessionAds を「作成後最初のpoll」でしか送らない。以降のpollは
 * sessionAdsRequired=true かつ sessionAds=null(serverSentEmptyAds)になるため、
 * メディアURL入りの前回リストを保持し続ける必要がある。
 * @param {Array|null} previousAds 前回保持した広告リスト
 * @param {object} info pollSession/報告応答のsession info(adStateを書き換える)
 * @returns {Array|null} 次に保持する広告リスト
 */
export function mergeAdStateForPoll(previousAds, info) {
  const adState = info?.adState;
  if (!adState) return previousAds ?? null;
  const current = Array.isArray(adState.sessionAds) ? adState.sessionAds : [];
  if (adState.isAdsRequired && adState.serverSentEmptyAds && current.length === 0 && previousAds?.length) {
    adState.sessionAds = previousAds;
    return previousAds;
  }
  return current.length > 0 ? current : previousAds ?? null;
}
