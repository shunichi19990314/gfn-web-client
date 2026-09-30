// ヘッダビルダー群
// 出典: OpenNOW v0.5.5 clientHeaders.ts / native gfn.rs:2514-2588, cloudmatch.rs:1243-1266, 1812-1820
import { randomUUID } from 'node:crypto';
import {
  GFN_CLIENT_VERSION,
  GFN_PC_CEF_USER_AGENT,
  GFN_PC_CLIENT_VERSION,
  GFN_PLAY_ORIGIN,
  GFN_PLAY_REFERER,
  GFN_USER_AGENT,
  LCARS_CLIENT_ID,
  NVIDIA_FILE_ORIGIN,
  NVIDIA_FILE_REFERER,
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

/** userinfo 用 — gfn.rs:1716-1721(Origin が https://nvfile な点に注意)
 *  pc=true: GFN-PCクライアント相当(Electron helpers.ts buildNvidiaAuthHeaders)— CEF UA */
export function userInfoHeaders(accessToken, { pc = false } = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: NVIDIA_FILE_ORIGIN,
    'User-Agent': pc ? GFN_PC_CEF_USER_AGENT : STEAM_DECK_USER_AGENT,
  };
}

/** client_token 用 — gfn.rs:1763-1771
 *  pc=true: GFN-PCクライアント相当(Electron tokenRefresh.ts requestClientToken は
 *  buildNvidiaAuthHeaders = Origin https://nvfile + CEF UA を使用) */
export function clientTokenHeaders(accessToken, { pc = false } = {}) {
  if (pc) {
    return {
      Accept: ACCEPT_JSON,
      Authorization: `Bearer ${accessToken}`,
      Origin: NVIDIA_FILE_ORIGIN,
      'User-Agent': GFN_PC_CEF_USER_AGENT,
    };
  }
  return {
    Accept: ACCEPT_JSON,
    Authorization: `Bearer ${accessToken}`,
    Origin: GFN_PLAY_ORIGIN,
    Referer: GFN_PLAY_REFERER,
    'User-Agent': STEAM_DECK_USER_AGENT,
  };
}

/** GFN-PC認証( authorize / token / client_token )用 —
 *  Electron helpers.ts buildNvidiaAuthHeaders(clientHeaders.ts:60-79)準拠。
 *  Origin は常に https://nvfile、Referer は includeReferer 時のみ(token交換で使用)。 */
export function nvidiaPcAuthHeaders({ bearerToken, contentType, includeReferer = false } = {}) {
  const headers = {
    Accept: ACCEPT_JSON,
    Origin: NVIDIA_FILE_ORIGIN,
    'User-Agent': GFN_PC_CEF_USER_AGENT,
  };
  if (includeReferer) headers.Referer = NVIDIA_FILE_REFERER;
  if (bearerToken !== undefined) headers.Authorization = `Bearer ${bearerToken}`;
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
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

/** CloudMatch(v2/*)用 — Electron版 buildGfnCloudMatchHeaders 準拠(clientHeaders.ts:157-181)
 *  注意: Rustネイティブ版(Bifrost UA/text-plain)ではなく、Web(WebRTC)セッション用のヘッダ。
 *  作成時は Origin/Referer あり、ポーリング時は無し(Electron cloudmatch.ts:116,146) */
export const GFN_WEB_CLIENT_VERSION = GFN_PC_CLIENT_VERSION;
export const GFN_WEB_USER_AGENT = GFN_PC_CEF_USER_AGENT;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * @param {'electron'|'browser'|'native'} profile
 *   electron(既定・v0.5.17): OpenNOW Electron版 buildGfnCloudMatchHeaders の完全再現 —
 *     NATIVE/NVIDIA-CLASSIC + nv-browser-type:CHROME + CEF(Win)UA + nv-device-os:WINDOWS。
 *     WebRTCストリーミングが実際に動作していた 2026年4-7月期の OpenNOW はこのヘッダ +
 *     GFN-PCクライアントID(ZU7sPN…)のトークンで usage 2/17 メディアエンドポイントを
 *     受け取っていた(docs/streamer-investigation.md @ c9908f45)。
 *   browser: 公式Webクライアント猜测(BROWSER/WEBRTC)— v0.5.16 で実測したが
 *     usages=[14] のままで効果なし(2026-09-30)。比較実験用に保持。
 *   native:  旧既定(LINUX device-os)。同上、比較実験用に保持。
 */
export function cloudmatchHeaders(token, deviceId, { clientId, includeOrigin = true, profile = 'electron' } = {}) {
  const headers = {
    Authorization: `GFNJWT ${token}`,
    'Content-Type': 'application/json',
    'nv-browser-type': 'CHROME',
    'nv-client-id': clientId ?? randomUUID(),
    'nv-client-version': GFN_PC_CLIENT_VERSION,
    'x-device-id': deviceId,
  };
  if (profile === 'browser') {
    headers['User-Agent'] = BROWSER_USER_AGENT;
    headers['nv-client-streamer'] = 'WEBRTC';
    headers['nv-client-type'] = 'BROWSER';
    headers['nv-device-os'] = 'LINUX';
    headers['nv-device-type'] = 'DESKTOP';
    headers['nv-device-make'] = 'UNKNOWN';
    headers['nv-device-model'] = 'UNKNOWN';
    headers['nv-client-platform-name'] = 'browser';
  } else if (profile === 'native') {
    headers['User-Agent'] = GFN_PC_CEF_USER_AGENT;
    headers['nv-client-streamer'] = 'NVIDIA-CLASSIC';
    headers['nv-client-type'] = 'NATIVE';
    headers['nv-device-os'] = 'LINUX';
    headers['nv-device-type'] = 'DESKTOP';
    headers['nv-device-make'] = 'UNKNOWN';
    headers['nv-device-model'] = 'UNKNOWN';
  } else {
    // electron: buildGfnCloudMatchHeaders + Windows deviceIdentity の完全一致
    headers['User-Agent'] = GFN_PC_CEF_USER_AGENT;
    headers['nv-client-streamer'] = 'NVIDIA-CLASSIC';
    headers['nv-client-type'] = 'NATIVE';
    headers['nv-device-os'] = 'WINDOWS';
    headers['nv-device-type'] = 'DESKTOP';
    headers['nv-device-make'] = 'UNKNOWN';
    headers['nv-device-model'] = 'UNKNOWN';
  }
  if (includeOrigin !== false) {
    headers.Origin = GFN_PLAY_ORIGIN;
    headers.Referer = GFN_PLAY_REFERER;
  }
  return headers;
}
