// ヘッダビルダー群
// 出典: OpenNOW v0.5.5 clientHeaders.ts / native gfn.rs:2514-2588, cloudmatch.rs:1243-1266, 1812-1820
import {
  GFN_CLIENT_VERSION,
  GFN_PLAY_ORIGIN,
  GFN_PLAY_REFERER,
  GFN_USER_AGENT,
  LCARS_CLIENT_ID,
  NVIDIA_FILE_ORIGIN,
  STEAM_DECK_CLIENT_ID,
  STEAM_DECK_USER_AGENT,
} from './config.js';

const ACCEPT_JSON = 'application/json, text/plain, */*';

/** login.nvidia.com 系(device authorize / token / client_token)用 — gfn.rs:482-500 */
export function steamDeckAuthHeaders({ deviceId } = {}) {
  const headers = {
    Accept: ACCEPT_JSON,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: GFN_PLAY_ORIGIN,
    Referer: GFN_PLAY_REFERER,
    'User-Agent': STEAM_DECK_USER_AGENT,
  };
  if (deviceId) {
    headers['x-device-id'] = deviceId;
    headers['nv-client-id'] = STEAM_DECK_CLIENT_ID;
    headers['nv-client-streamer'] = 'WEBRTC';
    headers['nv-client-type'] = 'BROWSER';
    headers['nv-client-platform-name'] = 'browser';
    headers['nv-browser-type'] = 'CHROME';
    headers['nv-device-os'] = 'STEAMOS';
    headers['nv-device-type'] = 'CONSOLE';
    headers['nv-device-model'] = 'STEAMDECK';
    headers['nv-device-make'] = 'VALVE';
  }
  return headers;
}

/** userinfo 用 — gfn.rs:1716-1721(Origin が https://nvfile な点に注意) */
export function userInfoHeaders(accessToken) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: NVIDIA_FILE_ORIGIN,
    'User-Agent': STEAM_DECK_USER_AGENT,
  };
}

/** client_token 用 — gfn.rs:1763-1771 */
export function clientTokenHeaders(accessToken) {
  return {
    Accept: ACCEPT_JSON,
    Authorization: `Bearer ${accessToken}`,
    Origin: GFN_PLAY_ORIGIN,
    Referer: GFN_PLAY_REFERER,
    'User-Agent': STEAM_DECK_USER_AGENT,
  };
}

/** serviceUrls / 公開カタログ用 — gfn.rs:430-435, 1101-1106 */
export function gfnPlainHeaders() {
  return { Accept: 'application/json', 'User-Agent': GFN_USER_AGENT };
}

/**
 * LCARSヘッダ(GraphQL/MES/serverInfo)— gfn.rs:2529-2588
 * @param {'NATIVE'|'BROWSER'} clientType
 * @param {'NVIDIA-CLASSIC'|'WEBRTC'} streamer
 */
export function lcarsHeaders(token, { clientType = 'NATIVE', streamer = 'NVIDIA-CLASSIC', deviceOs = 'LINUX' } = {}) {
  return {
    Accept: ACCEPT_JSON,
    Authorization: `GFNJWT ${token}`,
    'nv-client-id': LCARS_CLIENT_ID,
    'nv-client-type': clientType,
    'nv-client-version': GFN_CLIENT_VERSION,
    'nv-client-streamer': streamer,
    'nv-device-os': deviceOs,
    'nv-device-type': 'DESKTOP',
    'nv-device-make': 'GENERIC',
    'nv-device-model': 'PC',
    'x-nv-client-identity': 'GFN-PC',
    'User-Agent': GFN_USER_AGENT,
  };
}

/** GraphQL(games.geforce.com)用 — gfn.rs:2514-2528 = lcars + JSON + Origin/Referer */
export function graphqlHeaders(token) {
  return {
    ...lcarsHeaders(token),
    'Content-Type': 'application/json',
    Origin: GFN_PLAY_ORIGIN,
    Referer: GFN_PLAY_REFERER,
    'nv-browser-type': 'CHROME',
  };
}

/** CloudMatch(v2/*)用 — cloudmatch.rs:1243-1266。Phase 2 で使用する */
export function cloudmatchHeaders(token, deviceId, { platform = 'windows' } = {}) {
  const userAgent = `GFN-PC/30.0 (${platform}) BifrostClientSDK/4.9 (38495286)`;
  return {
    'User-Agent': userAgent,
    Authorization: `GFNJWT ${token}`,
    'Content-Type': 'application/json',
    'nv-client-id': LCARS_CLIENT_ID,
    'nv-client-streamer': 'NVIDIA-CLASSIC',
    'nv-client-type': 'NATIVE',
    'nv-client-version': GFN_CLIENT_VERSION,
    'nv-device-os': 'LINUX',
    'nv-device-type': 'DESKTOP',
    'nv-device-make': 'GENERIC',
    'nv-device-model': 'PC',
    'x-device-id': deviceId,
    'x-nv-client-identity': userAgent,
  };
}
