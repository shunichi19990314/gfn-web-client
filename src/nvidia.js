// NVIDIA GeForce NOW アップストリームAPI クライアント
// OpenNOW (MIT) の Rustコア/旧Electron実装のJS移植:
//   - parse_providers            → gfn.rs:1979
//   - device authorize/token     → gfn.rs:472-650
//   - client_token/userinfo/JWT  → gfn.rs:1703-1793, 2589
//   - serverInfo(vpcId/regions)  → gfn.rs:1462-1497, cloudmatch.rs:1575
//   - library GraphQL + mapping  → gfn.rs:1147-1235, 2060-2193(app_to_game), 2207-2247(images)
//   - MES subscription           → gfn.rs:1500-1600
import {
  CLIENT_TOKEN_GRANT_TYPE,
  DEFAULT_IDP_ID,
  DEFAULT_STREAMING_URL,
  DEVICE_GRANT_TYPE,
  ENDPOINTS,
  LCARS_CLIENT_ID,
  LIBRARY_FETCH_COUNT,
  LIBRARY_FILTERS,
  LIBRARY_SORT_STRING,
  MES_SERVICE_NAME,
  SCOPES,
  STEAM_DECK_CLIENT_ID,
  isTrustedStreamingBase,
} from './config.js';
import {
  clientTokenHeaders,
  gfnPlainHeaders,
  graphqlHeaders,
  lcarsHeaders,
  steamDeckAuthHeaders,
  userInfoHeaders,
} from './headers.js';
import { LIBRARY_QUERY } from './queries.js';
import { UpstreamError, assertOk, fetchJson } from './upstream.js';

// ---------- 基本ユーティリティ ----------

function formBody(pairs) {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  return params.toString();
}

/** GFNJWTに使うトークン: id_token優先、無ければaccess_token(gfn.rs:1157-1159) */
export function sessionToken(tokens) {
  return tokens.idToken ?? tokens.accessToken;
}

/** JWTペイロードをデコード(検証はしない — 署名確認はNVIDIA側API呼び出しで行う) */
export function jwtPayload(token) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** JWTペイロードからユーザー情報を抽出(gfn.rs:2589 user_from_jwt) */
export function userFromJwt(token) {
  const payload = jwtPayload(token);
  if (!payload || typeof payload.sub !== 'string') return null;
  return {
    userId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    displayName: typeof payload.preferred_username === 'string' ? payload.preferred_username : null,
    avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

// ---------- プロバイダ発見 ----------

/** GET /v1/serviceUrls → LoginProvider[](gfn.rs:419-449, 1979-2005) */
export async function fetchProviders() {
  const result = await fetchJson(ENDPOINTS.serviceUrls, { headers: gfnPlainHeaders() });
  const endpoints = result.ok ? result.payload?.gfnServiceInfo?.gfnServiceEndpoints : null;
  const providers = [];
  if (Array.isArray(endpoints)) {
    for (const entry of endpoints) {
      if (
        typeof entry?.loginProviderCode !== 'string' ||
        typeof entry?.idpId !== 'string' ||
        typeof entry?.streamingServiceUrl !== 'string'
      ) {
        continue;
      }
      let streamingServiceUrl = entry.streamingServiceUrl;
      if (!streamingServiceUrl.endsWith('/')) streamingServiceUrl += '/';
      providers.push({
        idpId: entry.idpId,
        code: entry.loginProviderCode,
        displayName:
          entry.loginProviderCode === 'BPC'
            ? 'bro.game'
            : entry.loginProviderDisplayName ?? entry.loginProviderCode,
        streamingServiceUrl,
        priority: Number(entry.loginProviderPriority ?? 0),
      });
    }
    providers.sort((a, b) => a.priority - b.priority);
  }
  if (providers.length === 0) {
    providers.push({
      idpId: DEFAULT_IDP_ID,
      code: 'NVIDIA',
      displayName: 'NVIDIA',
      streamingServiceUrl: DEFAULT_STREAMING_URL,
      priority: 0,
    });
  }
  return providers;
}

// ---------- デバイスフロー認証 ----------

/** POST /device/authorize(gfn.rs:472-543) */
export async function deviceAuthorize({ idpId, deviceId }) {
  const result = await fetchJson(ENDPOINTS.deviceAuthorize, {
    method: 'POST',
    headers: steamDeckAuthHeaders({ deviceId }),
    body: formBody([
      ['client_id', STEAM_DECK_CLIENT_ID],
      ['scope', SCOPES],
      ['device_id', deviceId],
      ['display_name', 'GFNWebMVP'],
      ['idp_id', idpId],
    ]),
  });
  const payload = assertOk(result, 'Device authorization failed');
  for (const key of ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete']) {
    if (typeof payload?.[key] !== 'string') {
      throw new UpstreamError('upstream_error', `Device authorization response missing ${key}`);
    }
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    verificationUriComplete: payload.verification_uri_complete,
    expiresInSec: Number(payload.expires_in ?? 600),
    intervalSec: Math.max(1, Number(payload.interval ?? 5)),
  };
}

/** POST /token (device_code grant)(gfn.rs:566-650)
 * @returns {{status:'pending'|'slow_down'|'expired'|'access_denied'|'authorized'|'error', tokens?: object, error?: string, intervalSeconds?: number}}
 */
export async function deviceTokenPoll(deviceCode) {
  const result = await fetchJson(ENDPOINTS.token, {
    method: 'POST',
    headers: steamDeckAuthHeaders(),
    body: formBody([
      ['grant_type', DEVICE_GRANT_TYPE],
      ['device_code', deviceCode],
      ['client_id', STEAM_DECK_CLIENT_ID],
    ]),
  });
  if (!result.ok) {
    const error = result.payload?.error ?? 'device_token_exchange_failed';
    const description = result.payload?.error_description ?? error;
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending', error: description };
      case 'slow_down':
        return { status: 'slow_down', error: description, intervalSeconds: 10 };
      case 'expired_token':
        return { status: 'expired', error: description };
      case 'access_denied':
        return { status: 'access_denied', error: description };
      case 'invalid_grant':
      case 'invalid_token':
      case 'token_revoked':
        return { status: 'expired', error: description };
      default:
        return { status: 'error', error: `${description} (${result.status})` };
    }
  }
  const payload = result.payload ?? {};
  if (typeof payload.access_token !== 'string') {
    return { status: 'error', error: 'Token response missing access_token' };
  }
  return {
    status: 'authorized',
    tokens: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      idToken: payload.id_token ?? null,
      clientToken: payload.client_token ?? null,
      expiresAt: Date.now() + Number(payload.expires_in ?? 86_400) * 1000,
      authClientId: STEAM_DECK_CLIENT_ID,
    },
  };
}

/** GET /client_token(gfn.rs:1753-1793)。失敗しても致命ではない */
export async function ensureClientToken(tokens) {
  try {
    const result = await fetchJson(ENDPOINTS.clientToken, {
      headers: clientTokenHeaders(tokens.accessToken),
    });
    const payload = assertOk(result, 'Client token request failed');
    if (typeof payload?.client_token === 'string') {
      return {
        ...tokens,
        clientToken: payload.client_token,
        clientTokenExpiresAt: Date.now() + Number(payload.expires_in ?? 86_400) * 1000,
      };
    }
  } catch {
    // client_token はリフレッシュ用の保険。取得失敗は無視して続行(gfn.rs:625-630と同様)
  }
  return tokens;
}

/** GET /userinfo(gfn.rs:1703-1752) */
export async function fetchUserInfo(accessToken) {
  const result = await fetchJson(ENDPOINTS.userinfo, { headers: userInfoHeaders(accessToken) });
  const payload = assertOk(result, 'User info failed');
  if (typeof payload?.sub !== 'string') {
    throw new UpstreamError('upstream_error', 'User info response missing sub');
  }
  return {
    userId: payload.sub,
    email: payload.email ?? null,
    displayName: payload.preferred_username ?? (payload.email ? String(payload.email).split('@')[0] : null) ?? 'User',
    avatarUrl: payload.picture ?? null,
  };
}

/** id_token優先→userinfoフォールバックでユーザー情報を確定 */
export async function resolveUser(tokens) {
  const fromJwt =
    userFromJwt(tokens.idToken ?? '') ?? userFromJwt(tokens.accessToken);
  if (fromJwt && (fromJwt.email || fromJwt.avatarUrl)) {
    return {
      userId: fromJwt.userId,
      email: fromJwt.email,
      displayName: fromJwt.displayName ?? fromJwt.email?.split('@')[0] ?? 'User',
      avatarUrl: fromJwt.avatarUrl,
    };
  }
  const info = await fetchUserInfo(tokens.accessToken);
  return {
    userId: info.userId,
    email: info.email,
    displayName: info.displayName ?? fromJwt?.displayName ?? 'User',
    avatarUrl: info.avatarUrl ?? fromJwt?.avatarUrl,
  };
}

/** トークンリフレッシュ(client_token grant 優先 → refresh_token)(gfn.rs:1808-1870) */
export async function refreshTokens(tokens, userId) {
  const attempts = [];
  if (tokens.clientToken) {
    attempts.push(
      formBody([
        ['grant_type', CLIENT_TOKEN_GRANT_TYPE],
        ['client_token', tokens.clientToken],
        ['client_id', tokens.authClientId ?? STEAM_DECK_CLIENT_ID],
        ['sub', userId],
      ]),
    );
  }
  if (tokens.refreshToken) {
    attempts.push(
      formBody([
        ['grant_type', 'refresh_token'],
        ['refresh_token', tokens.refreshToken],
        ['client_id', tokens.authClientId ?? STEAM_DECK_CLIENT_ID],
      ]),
    );
  }
  let lastError = null;
  for (const body of attempts) {
    const result = await fetchJson(ENDPOINTS.token, {
      method: 'POST',
      headers: steamDeckAuthHeaders(),
      body,
    });
    if (result.ok && typeof result.payload?.access_token === 'string') {
      const payload = result.payload;
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? tokens.refreshToken ?? null,
        idToken: payload.id_token ?? tokens.idToken ?? null,
        clientToken: payload.client_token ?? tokens.clientToken ?? null,
        clientTokenExpiresAt: tokens.clientTokenExpiresAt ?? null,
        expiresAt: Date.now() + Number(payload.expires_in ?? 86_400) * 1000,
        authClientId: tokens.authClientId ?? STEAM_DECK_CLIENT_ID,
      };
    }
    lastError = result.payload?.error ?? `HTTP ${result.status}`;
  }
  throw new UpstreamError('authentication_required', `Token refresh failed: ${lastError ?? 'no grant available'}`);
}

// ---------- serverInfo(vpcId + リージョン) ----------

/**
 * GET {streamingBase}v2/serverInfo(gfn.rs:1462-1497, cloudmatch.rs:1575-1607)
 * @returns {{vpcId: string|null, regions: Array<{name:string,url:string}>, localRegion: string|null}}
 */
export async function fetchServerInfo(streamingBaseUrl, token) {
  if (!isTrustedStreamingBase(streamingBaseUrl)) {
    throw new UpstreamError('invalid_params', `Untrusted streaming service URL: ${streamingBaseUrl}`);
  }
  const url = new URL('v2/serverInfo', streamingBaseUrl);
  const result = await fetchJson(url, { headers: lcarsHeaders(token, { clientType: 'BROWSER', streamer: 'WEBRTC' }) });
  const payload = assertOk(result, 'Region discovery failed');
  const metaData = Array.isArray(payload?.metaData) ? payload.metaData : [];
  const valueFor = (key) => {
    const entry = metaData.find((e) => e?.key === key);
    return typeof entry?.value === 'string' ? entry.value : null;
  };
  const localRegion = valueFor('local-region');
  const regions = [];
  const seen = new Set();
  const names = [];
  if (localRegion) names.push(localRegion);
  for (const name of (valueFor('gfn-regions') ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
  }
  for (const name of names) {
    const raw = valueFor(name);
    if (!raw || !raw.startsWith('https://')) continue;
    const normalized = raw.endsWith('/') ? raw : `${raw}/`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    regions.push({ name, url: normalized });
  }
  return {
    vpcId: payload?.requestStatus?.serverId ?? null,
    regions,
    localRegion,
  };
}

// ---------- ライブラリ GraphQL ----------

// gfn.rs:2207-2247 image_values / first_image
function imageValues(value, width) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .map((v) => {
      const trimmed = v.trim();
      return trimmed.includes('img.nvidiagrid.net') ? `${trimmed};f=jpg;w=${width}` : trimmed;
    });
}

function firstImage(images, keys, width) {
  for (const key of keys) {
    const values = imageValues(images?.[key], width);
    if (values.length > 0) return values[0];
  }
  return null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === 'string'
        ? item
        : ['name', 'label', 'title', 'displayName']
            .map((key) => item?.[key])
            .find((v) => typeof v === 'string') ?? null,
    )
    .filter((v) => v !== null);
}

function gfnFeatureEnabled(features, expectedKey) {
  if (!Array.isArray(features)) return false;
  return features.some((feature) => {
    if (feature?.key !== expectedKey) return false;
    const value = feature.value ?? feature.values;
    if (Array.isArray(value)) return value.some((v) => v === true || v === 'true' || v === 'TRUE');
    return value === true || value === 'true' || value === 'TRUE';
  });
}

const isDigits = (value) => typeof value === 'string' && value.length > 0 && [...value].every((c) => c >= '0' && c <= '9');

/** gfn.rs:2060-2193 app_to_game のJS移植 */
export function appToGame(app) {
  const id = app?.id;
  const title = typeof app?.title === 'string' ? app.title.trim() : '';
  if (typeof id !== 'string' || title === '') return null;

  const variants = (Array.isArray(app.variants) ? app.variants : [])
    .map((variant) => {
      if (typeof variant?.id !== 'string') return null;
      const libraryStatus = variant.gfn?.library?.status ?? null;
      return {
        id: variant.id,
        store: variant.appStore ?? 'Unknown',
        storeUrl: variant.storeUrl ?? null,
        supportedControls: Array.isArray(variant.supportedControls) ? variant.supportedControls : [],
        librarySelected: variant.gfn?.library?.selected === true,
        inLibrary: ['MANUAL', 'PLATFORM_SYNC', 'IN_LIBRARY'].includes(libraryStatus),
        libraryStatus,
        lastPlayedDate: variant.gfn?.library?.lastPlayedDate ?? null,
        gfnStatus: variant.gfn?.status ?? null,
        supportsInGameSettingsPersistence: gfnFeatureEnabled(variant.gfn?.features, 'IN_GAME_SETTINGS_PERSISTENCE_ENABLED'),
      };
    })
    .filter((v) => v !== null);
  if (variants.length === 0) return null;

  const selectedIndex =
    variants.findIndex((v) => v.librarySelected) !== -1
      ? variants.findIndex((v) => v.librarySelected)
      : variants.findIndex((v) => v.inLibrary) !== -1
        ? variants.findIndex((v) => v.inLibrary)
        : 0;
  const launchAppId =
    (isDigits(variants[selectedIndex]?.id) && variants[selectedIndex].id) ||
    variants.map((v) => v.id).find(isDigits) ||
    (isDigits(id) ? id : null);

  const images = app.images ?? {};
  const publisher = app.publisherName ?? null;
  const developer = app.developerName ?? null;
  const genres = stringArray(app.genres);
  const availableStores = variants.map((v) => v.store);
  const screenshots = imageValues(images.SCREENSHOTS, 1200);

  return {
    id,
    uuid: id,
    launchAppId,
    title,
    developerName: developer,
    publisherName: publisher,
    genres,
    supportedControls: stringArray(app.supportedControls),
    imageUrl: firstImage(images, ['GAME_BOX_ART', 'KEY_IMAGE', 'KEY_ART', 'HERO_IMAGE', 'TV_BANNER'], 900),
    heroImageUrl: firstImage(images, ['MARQUEE_HERO_IMAGE', 'HERO_IMAGE', 'TV_BANNER', 'FEATURE_IMAGE', 'KEY_IMAGE', 'KEY_ART'], 1200),
    keyArtUrl: firstImage(images, ['KEY_ART', 'KEY_IMAGE'], 900),
    screenshotUrl: screenshots[0] ?? null,
    screenshotUrls: screenshots,
    playType: app.gfn?.playType ?? null,
    membershipTierLabel: app.gfn?.minimumMembershipTierLabel ?? null,
    playabilityState: app.gfn?.playabilityState ?? null,
    availableStores,
    searchText: [title, publisher, developer, ...availableStores, ...genres].filter(Boolean).join(' ').toLowerCase(),
    lastPlayed: variants.map((v) => v.lastPlayedDate).find((v) => v !== null && v !== undefined) ?? null,
    isInLibrary: variants.some((v) => v.inLibrary),
    selectedVariantIndex: selectedIndex,
    variants,
  };
}

function graphqlErrorMessage(payload) {
  const errors = payload?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => e?.message).filter(Boolean).join('; ') || 'GraphQL error';
}

/**
 * ライブラリ1ページ取得(gfn.rs:1147-1235)
 * @returns {{games: object[], totalCount: number, hasNextPage: boolean, nextCursor: string}}
 */
export async function fetchLibraryPage({ token, vpcId, cursor = '', locale = 'en_US', fetchCount = LIBRARY_FETCH_COUNT }) {
  const variables = {
    vpcId,
    locale,
    sortString: LIBRARY_SORT_STRING,
    fetchCount: Math.min(Math.max(1, fetchCount), LIBRARY_FETCH_COUNT),
    cursor,
    filters: LIBRARY_FILTERS,
  };
  const result = await fetchJson(ENDPOINTS.graphQl, {
    method: 'POST',
    headers: graphqlHeaders(token),
    body: JSON.stringify({ query: LIBRARY_QUERY, variables }),
  });
  const payload = assertOk(result, 'GFN library query failed');
  const graphqlError = graphqlErrorMessage(payload);
  if (graphqlError) {
    throw new UpstreamError('graphql_error', graphqlError, { payload });
  }
  const apps = payload?.data?.apps;
  const items = Array.isArray(apps?.items) ? apps.items : [];
  const games = items.map(appToGame).filter((g) => g !== null);
  return {
    games,
    totalCount: Number(apps?.pageInfo?.totalCount ?? games.length),
    hasNextPage: apps?.pageInfo?.hasNextPage === true,
    nextCursor: apps?.pageInfo?.endCursor ?? '',
  };
}

// ---------- 購読情報(MES) ----------

/** gfn.rs:1500-1600 subscription のJS移植 */
export async function fetchSubscription({ token, vpcId, userId }) {
  const url = new URL(ENDPOINTS.subscriptions);
  url.searchParams.set('serviceName', MES_SERVICE_NAME);
  url.searchParams.set('languageCode', 'en_US');
  url.searchParams.set('vpcId', vpcId ?? 'GFN-PC');
  url.searchParams.set('userId', userId);
  const result = await fetchJson(url, { headers: lcarsHeaders(token) });
  const data = assertOk(result, 'Subscription request failed');
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) || 0 : 0);
  const allotted = num(data?.allottedTimeInMinutes);
  const purchased = num(data?.purchasedTimeInMinutes);
  const rolled = num(data?.rolledOverTimeInMinutes);
  const resolutions = (Array.isArray(data?.features?.resolutions) ? data.features.resolutions : [])
    .filter((r) => r?.isEntitled === true)
    .map((r) => ({ width: r.widthInPixels, height: r.heightInPixels, fps: r.framesPerSecond }))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0));
  const storageAddon = (Array.isArray(data?.addons) ? data.addons : []).find(
    (addon) => addon?.type === 'STORAGE' && addon?.subType === 'PERMANENT_STORAGE' && addon?.status === 'OK',
  );
  return {
    membershipTier: data?.membershipTier ?? 'FREE',
    allottedTimeInMinutes: allotted,
    purchasedTimeInMinutes: purchased,
    rolledOverTimeInMinutes: rolled,
    totalTimeInMinutes: num(data?.totalTimeInMinutes) || allotted + purchased + rolled,
    remainingTimeInMinutes: num(data?.remainingTimeInMinutes),
    resolutions,
    hasPersistentStorage: Boolean(storageAddon),
  };
}

// ---------- トークンインポート(公式Webクライアントからのログイン) ----------

/**
 * 貼り付けられたJWT(公式 play.geforcenow.com のセッション由来)を検証し、
 * セッション材料を返す。検証は MES(購読API)への GFNJWT 認証呼び出しで行う —
 * MESは偽造トークンを 401 "invalid token" で拒否する(2026-09-28実測)。
 * serverInfo / GraphQL introspection は無認証でも200を返すため検証に使えない。
 * @returns {{provider: object, user: object, expiresAt: number, vpcId: string|null, membershipTier: string}}
 */
export async function validateImportedToken(token) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed || trimmed.split('.').length !== 3) {
    throw new UpstreamError('invalid_params', 'Paste a JWT token (a long string in the form xxx.yyy.zzz)');
  }
  const payload = jwtPayload(trimmed);
  if (!payload || typeof payload.sub !== 'string') {
    throw new UpstreamError('invalid_params', 'This token is not an NVIDIA ID JWT (missing "sub" claim)');
  }
  const expiresAt = Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : Date.now() + 24 * 60 * 60 * 1000;
  if (expiresAt <= Date.now() + 30_000) {
    throw new UpstreamError('authentication_required', 'This token has expired. Sign in again at play.geforcenow.com and copy a fresh token.');
  }

  // プロバイダ既定(NVIDIA)でストリーミング基を決定
  let provider = {
    idpId: DEFAULT_IDP_ID,
    code: 'NVIDIA',
    displayName: 'NVIDIA',
    streamingServiceUrl: DEFAULT_STREAMING_URL,
    priority: 0,
  };
  try {
    const providers = await fetchProviders();
    provider = providers.find((p) => p.code === 'NVIDIA') ?? providers[0] ?? provider;
  } catch {
    /* 既定プロバイダで続行 */
  }

  // vpcId 解決(v2/serverInfo は公開エンドポイント。失敗しても GFN-PC フォールバックで続行可)
  let vpcId = 'GFN-PC';
  try {
    const info = await fetchServerInfo(provider.streamingServiceUrl, trimmed);
    if (info.vpcId) vpcId = info.vpcId;
  } catch {
    /* フォールバック使用 */
  }

  // 本命の検証: MES(購読API)は GFNJWT を実検証する(偽造トークンは401 "invalid token")。
  // serverInfo/GraphQL introspection は無認証でも通るため検証には使えない(2026-09-28実測)。
  const subscription = await fetchSubscription({ token: trimmed, vpcId, userId: payload.sub });

  // 表示名の補完(JWTに email/picture が無い場合のみ userinfo を試す)
  let user = {
    userId: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    displayName: typeof payload.preferred_username === 'string' ? payload.preferred_username : null,
    avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
  };
  if (!user.email && !user.avatarUrl) {
    try {
      const info2 = await fetchUserInfo(trimmed);
      user = {
        userId: user.userId,
        email: info2.email ?? user.email,
        displayName: user.displayName ?? info2.displayName,
        avatarUrl: info2.avatarUrl ?? user.avatarUrl,
      };
    } catch {
      /* 表示情報はベストエフォート */
    }
  }
  if (!user.displayName) {
    user.displayName = user.email ? user.email.split('@')[0] : 'Imported User';
  }
  return { provider, user, expiresAt, vpcId, membershipTier: subscription.membershipTier };
}
