// エンドポイント・クライアント固定値
// 出典: OpenNOW (MIT) native/opennow-core/src/gfn.rs, cloudmatch.rs,
//       v0.5.5 opennow-stable/src/main/platforms/gfn/auth/constants.ts, clientHeaders.ts
// これらは NVIDIA 公式の仕様ではなく、いつでも変わりうる。

export const ENDPOINTS = {
  serviceUrls: 'https://pcs.geforcenow.com/v1/serviceUrls',
  deviceAuthorize: 'https://login.nvidia.com/device/authorize',
  token: 'https://login.nvidia.com/token',
  clientToken: 'https://login.nvidia.com/client_token',
  userinfo: 'https://login.nvidia.com/userinfo',
  graphQl: 'https://games.geforce.com/graphql',
  lcarsGraphQl: 'https://apps.gxn.nvidia.com/graphql',
  subscriptions: 'https://mes.geforcenow.com/v4/subscriptions',
  publicCatalog:
    'https://static.nvidiagrid.net/supported-public-game-list/locales/gfnpc-en-US.json',
};

// 既定ストリーミング基(プロバイダ発見失敗時のフォールバック)
export const DEFAULT_STREAMING_URL = 'https://prod.cloudmatchbeta.nvidiagrid.net/';
export const DEFAULT_IDP_ID = 'PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg';

// OAuth クライアント
export const STEAM_DECK_CLIENT_ID = 'q61ddeJrVt7O90Nl-P-N7I36yctih4Ml6FyXLrb6j-U';
export const SCOPES = 'openid consent email tk_client age';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const CLIENT_TOKEN_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:client_token';

// LCARS / CloudMatch 系
export const LCARS_CLIENT_ID = 'ec7e38d4-03af-4b58-b131-cfb0495903ab';
export const GFN_CLIENT_VERSION = '2.0.87.131';

// User-Agent(gfn.rs:27-28 / clientHeaders.ts)
export const STEAM_DECK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; Steam Deck) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const GFN_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 NVIDIACEFClient/HEAD/7b92719716 GFN-PC/2.0.87.131';

export const GFN_PLAY_ORIGIN = 'https://play.geforcenow.com';
export const GFN_PLAY_REFERER = 'https://play.geforcenow.com/';
export const NVIDIA_FILE_ORIGIN = 'https://nvfile';

// トークンリフレッシュ窓(gfn.rs:30-31)
export const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
export const CLIENT_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

// GraphQL variables(gfn.rs:1147-1235)
export const LIBRARY_SORT_STRING =
  'variants.gfn.library.lastPlayedDate:DESC,computedValues.libraryAddedDate:DESC,sortName:ASC';
export const LIBRARY_FILTERS = {
  variants: { gfn: { library: { status: { notEquals: 'NOT_OWNED' } } } },
};
export const LIBRARY_FETCH_COUNT = 200;
export const LIBRARY_MAX_PAGES = 25;

// MES
export const MES_SERVICE_NAME = 'gfn_pc';

export const UPSTREAM_TIMEOUT_MS = 20_000;
export const UPSTREAM_CONNECT_TIMEOUT_MS = 8_000;

// 信頼できるストリーミング基の検証(gfn.rs:2495 trusted_streaming_base)
export function isTrustedStreamingBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    (host === 'prod.cloudmatchbeta.nvidiagrid.net' || host.endsWith('.geforcenow.nvidiagrid.net'))
  );
}
