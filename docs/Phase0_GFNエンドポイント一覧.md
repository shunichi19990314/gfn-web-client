# Phase 0 成果物:OpenNOW解析 — GeForce NOW API エンドポイント一覧

解析日: 2026-09-28
解析対象:
- **Rustコア(現行 main ブランチ)**: `OpenCloudGaming/OpenNOW` → `native/opennow-core/src/`(MITライセンス)
- **旧Electron版 TypeScript(v0.5.5 タグ)**: `opennow-stable/src/`(WebRTCブラウザ実装を含む最重要リファレンス)

解析用チェックアウト(同じ手順で再現可能):
```bash
git clone https://github.com/OpenCloudGaming/OpenNOW.git opennow-src
cd opennow-src && git fetch --depth 1 origin tag v0.5.5   # 旧Electron版(WebSocket/WebRTC実装を含む)
```
- Rustコア: `native/opennow-core/src/`(main ブランチ)
- 旧Electron版TS: タグ v0.5.5 の `opennow-stable/src/{main,renderer/src,shared}/platforms/gfn/**`

> 行番号は `main` ブランチ(2026-09-21時点 6e00a91)と v0.5.5 タグ基準。
> 記載のclient_id等はすべてOpenNOWの公開ソース(MIT)から抽出したものであり、
> NVIDIAの公式ドキュメントではない。いつでも変更されうる前提で扱うこと。

---

## 1. 全体シーケンス(ログイン→ゲーム起動→ストリーミング)

```
[クライアント]                                    [NVIDIA]
    │ ① GET  pcs.geforcenow.com/v1/serviceUrls ──▶ ログインプロバイダ(idpId, streamingServiceUrl)取得
    │ ② POST login.nvidia.com/device/authorize ───▶ device_code + user_code + verification_uri(QR表示)
    │    (ユーザーがブラウザでNVIDIA IDログイン&コード承認)
    │ ③ POST login.nvidia.com/token (device_code)▶ access_token / id_token / refresh_token / client_token
    │ ④ GET  login.nvidia.com/client_token ──────▶ client_token(短命・リフレッシュ用)
    │ ⑤ GET  login.nvidia.com/userinfo ──────────▶ sub / email / preferred_username / picture
    │ ⑥ GET  {streamingBase}v2/serverInfo ───────▶ リージョン一覧(metaData) + vpcId(requestStatus.serverId)
    │ ⑦ POST games.geforce.com/graphql ──────────▶ ライブラリ/ストア catalog (GFNJWT認証)
    │ ⑧ GET  mes.geforcenow.com/v4/subscriptions ▶  membershipTier・利用時間・解像度権限
    │ ⑨ POST {zoneBase}v2/session?keyboardLayout&languageCode ─▶ セッション作成(sessionRequestData)
    │    → レスポンス: sessionId, status, connectionInfo[], iceServerConfiguration, queuePosition
    │ ⑩ GET  {serverBase}v2/session/{id} ポーリング ─▶ status 2/3(ready/streaming)+ serverIp 確定
    │ ⑪ WSS  wss://{serverIp}:443/nvst/sign_in?pairing_id={sessionId} ─▶ NVSTシグナリング接続
    │    ◀── peer_msg{type:"offer", sdp}  (サーバーがSDPオファー送信)
    │ ⑫ RTCPeerConnection 生成 → answer + nvstSdp を peer_msg で返送 → ICE候補交換
    │ ⑬ ◀══════ WebRTCメディア(映像SRTP/音声Opus)+ DataChannel(入力) ══════▶ GPUサーバー
```

---

## 2. ホスト一覧(早見表)

| ホスト | 用途 | 認証方式 |
|---|---|---|
| `login.nvidia.com` | NVIDIA ID OAuth(デバイスフロー/認可コード/トークン) | なし→Bearer |
| `pcs.geforcenow.com` | サービスURL/プロバイダ発見 | なし |
| `games.geforce.com/graphql` | カタログGraphQL(CDN側) | `GFNJWT {id_token}` |
| `apps.gxn.nvidia.com/graphql` | LCARS GraphQL(アカウント情報等) | `GFNJWT {id_token}` |
| `mes.geforcenow.com` | 購読情報(Membership/Entitlement Service) | `GFNJWT`(LCARSヘッダ) |
| `prod.cloudmatchbeta.nvidiagrid.net` | CloudMatchデフォルト基(セッションAPI) | `GFNJWT` |
| `np-{zone}.cloudmatchbeta.nvidiagrid.net` | ゾーン別CloudMatch基(例: `np-tyo-01`=東京) | `GFNJWT` |
| `{serverIp}:443` (wss) | NVSTシグナリング(`/nvst/`)+ セッション直ポーリング | WSサブプロトコル |
| `*.geforcenow.nvidiagrid.net` (例 `prod.bpc.…`, `th.bpc.…`) | パートナー/アライアンスゾーン用CloudMatch変種(信頼ホスト扱い) | `GFNJWT` |
| `als.geforcenow.com/v1` | アカウントリンクサービス(Steam/Epic/GOG/Ubisoft等) | `Bearer {access_token}` |
| `static-als.nvidia.com` | アカウントリンク結果ランディングページ | なし |
| `api-prod.nvidia.com/gfn-paywall-api/api/v2` | 永続ストレージ/製品(paywall) | ヘッダ `idtoken` |
| `static.nvidiagrid.net` | 公開ゲームカタログJSON・静的アセット | なし |
| `img.nvidiagrid.net` | ゲームアートワークCDN | なし |
| `status.geforcenow.com` | GFN運用状況(components.json) | なし |
| `s1.stun.gamestream.nvidia.com:19308` | デフォルトSTUN | なし |
| `login.nvidia.com/device`(verification_uri) | ユーザーがコード承認するページ | — |
| `www.nvidia.com/en-us/account/gfn/manage-storage/` | ストレージ管理Web(外部リンク) | — |

信頼できるストリーミング基の検証規則(`gfn.rs:2495` `trusted_streaming_base`):
`https` かつ ホストが `prod.cloudmatchbeta.nvidiagrid.net` または `*.geforcenow.nvidiagrid.net`。

---

## 3. 認証(NVIDIA ID)

### 3.1 プロバイダ発見
```
GET https://pcs.geforcenow.com/v1/serviceUrls
Headers: Accept: application/json / User-Agent: GFN_USER_AGENT
```
→ `LoginProvider[]`: `{ idpId, code, displayName, streamingServiceUrl, priority }`
- 既定フォールバック(`gfn.rs:23-24`): `idpId=PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg`(NVIDIA)、
  `streamingServiceUrl=https://prod.cloudmatchbeta.nvidiagrid.net/`
- 出典: `gfn.rs:419-449`(providers)、Electron: `auth/providerDiscovery.ts`
- **実機確認(2026-09-28)**: 実際のレスポンスには NVIDIA のほか提携プロバイダが含まれる —
  `KDD`(au・日本, `prod.kdd.geforcenow.nvidiagrid.net`)、`TWM`(Taiwan Mobile)、`ZAI`(Zain) 等。
  日本の au ユーザーは KDD プロバイダ(idpId: `Q1qniNEW0JjufNnXEqzjTONfWoEYAvTdsg5mBRsEork`)を選ぶ必要あり

### 3.2 デバイスフロー(現行OpenNOWが使う方式。Web版にも最適)
**開始:**
```
POST https://login.nvidia.com/device/authorize
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: application/json, text/plain, */*
Origin: https://play.geforcenow.com
Referer: https://play.geforcenow.com/
User-Agent: Mozilla/5.0 (X11; Linux x86_64; Steam Deck) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36
x-device-id: {deviceId}
nv-client-id: {STEAM_DECK_CLIENT_ID}
nv-client-streamer: WEBRTC
nv-client-type: BROWSER
nv-client-platform-name: browser
nv-browser-type: CHROME
nv-device-os: STEAMOS / nv-device-type: CONSOLE / nv-device-model: STEAMDECK / nv-device-make: VALVE

body(form): client_id={STEAM_DECK_CLIENT_ID}&scope=openid+consent+email+tk_client+age
            &device_id={deviceId}&display_name=OpenNOW&idp_id={idpId}
```
→ `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in(既定600), interval(既定5) }`
- `verification_uri_complete` をQR化して表示(`qr_rows`)。ユーザーは `https://login.nvidia.com/device` で承認
- 出典: `gfn.rs:472-543`、Electron: `auth/deviceLogin.ts`

**トークン交換(ポーリング):**
```
POST https://login.nvidia.com/token
Content-Type: application/x-www-form-urlencoded; charset=UTF-8 (+ Origin/Referer/UA同上)
body: grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code={code}&client_id={STEAM_DECK_CLIENT_ID}
```
→ `{ access_token, refresh_token, id_token, client_token, expires_in(既定86400) }`
エラー: `authorization_pending`(継続)/ `slow_down`(10秒に延長)/ `expired_token` / `access_denied`
- 出典: `gfn.rs:566-650`

**クライアント固定値:**
| 名前 | 値 | 出典 |
|---|---|---|
| `STEAM_DECK_CLIENT_ID`(デバイスフロー用) | `q61ddeJrVt7O90Nl-P-N7I36yctih4Ml6FyXLrb6j-U` | `gfn.rs:25` / `auth/constants.ts` |
| `CLIENT_ID`(旧ブラウザOAuth用) | `ZU7sPN-miLujMD95LfOQ453IB0AtjM8sMyvgJ9wCXEQ` | `auth/constants.ts` |
| `DEFAULT_IDP_ID` | `PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg` | `gfn.rs:23` |
| `SCOPES` | `openid consent email tk_client age` | `gfn.rs:26` |

### 3.3 旧Electronのブラウザ型OAuth(認可コード+PKCE)— 参考
```
GET https://login.nvidia.com/authorize?response_type=code&device_id={sha256(host:user:opennow-stable)}
    &scope={SCOPES}&client_id={CLIENT_ID}&redirect_uri=http://localhost:{port}
    &ui_locales=en_US&nonce={hex16}&prompt=select_account&code_challenge={S256}&code_challenge_method=S256&idp_id={idpId}
```
- redirect用ローカルポート: `2259, 6460, 7119, 8870, 9096`(`auth/constants.ts` REDIRECT_PORTS)
- **Web版ではlocalhostリダイレクトが使えない**(NVIDIA側ホワイトリストがlocalhost前提のため)。
  → Web版はデバイスフロー(3.2)を採用するのが現実的
- 出典: `auth/oauthFlow.ts:25-60`

### 3.4 トークン維持
```
GET  https://login.nvidia.com/client_token          # Bearer {access_token}, Origin: play.geforcenow.com
     → { client_token, expires_in }                  # gfn.rs:1753-1793
POST https://login.nvidia.com/token                  # リフレッシュ
     grant_type=urn:ietf:params:oauth:grant-type:client_token&client_token=…&client_id=…&sub={userId}
     (失敗時) grant_type=refresh_token&refresh_token=…&client_id=…      # gfn.rs:1810-1870
GET  https://login.nvidia.com/userinfo               # Bearer {access_token}, Origin: https://nvfile
     → { sub, email, preferred_username, picture }   # gfn.rs:1703-1752
```
- リフレッシュ窓: access_token 10分前、client_token 5分前(`gfn.rs:30-31`)
- `user_from_jwt`: id_token(JWT)のペイロードから sub/email/picture を直接デコードしてuserinfoを省略(`gfn.rs:2589`)
- deviceIdの作り方2種:
  - 認証用 `device_id` = `sha256("{hostname}:{username}:opennow-stable")`(hex)
  - セッション用 `deviceHashId` = インストールごとに生成し永続化した `crypto.randomUUID()`(`deviceId.ts`)

---

## 4. カタログ / ライブラリ(GraphQL)

### 4.1 公開ゲームリスト(認証不要)
```
GET https://static.nvidiagrid.net/supported-public-game-list/locales/gfnpc-en-US.json
```
→ GFN対応ゲーム全リスト(JSON配列)。`gfn.rs:229,1078-1145`

### 4.2 CDN GraphQL(ストア/ライブラリ本体)
```
POST https://games.geforce.com/graphql     # Content-Type: application/json + graphql_headers(§10.2)
body: { "query": <インラインクエリ>, "variables": {…} }
```
インラインクエリ(`gfn.rs:36-210` に全文):
| 名前 | 用途 | variables 要点 |
|---|---|---|
| `GetLibraryApps`(LIBRARY_QUERY) | 所有ライブラリ | `vpcId, locale:"en_US", sortString:"variants.gfn.library.lastPlayedDate:DESC,…", fetchCount:200, cursor, filters:{variants:{gfn:{library:{status:{notEquals:"NOT_OWNED"}}}}}` — cursorページネーション(最大25周) `gfn.rs:1147-1235` |
| `GetStoreBrowseApps` | ストア閲覧 | vpcId, locale, cursor, filters |
| `GetStoreSearchApps` | ストア検索 | vpcId, locale, keyword |
| `GetStorePanels` / `GetStoreMarquee` / `GetStoreFilterDefinitions` | ストア装飾 | vpcId, locale, panelNames |

**persisted query方式(GET)** — 公式Webクライアントと同じ永続化クエリハッシュ:
```
GET https://games.geforce.com/graphql?extensions={"persistedQuery":{"sha256Hash":"{sha}"}}&huId={random}&variables={json}&requestType={type}
Content-Type: application/graphql
```
| requestType | sha256Hash |
|---|---|
| `panels/Marquee` | `dd4bddfdef4707dfe340cc2040d6bb9c4c45f706976fca15b2ef33221c385d7f` |
| `panels/MainV2`・`panels/Library` | `46ec15f267a056e7d5e46e629efa929529e5e7542a4850faece90b9f8fa5f810` |
| `panels/Library`(別変種) | `7f54d6bbbf3b1c09d0e5264dfa36f0f4aaf5e2678f2089f0cbf0d4dda18c3af9` |
| `filterGroupAndSortOrderDefinitions` | `ef725de5e93b093de1ac7418fed0ffb4f6ae2b9c14f743ab274a791521488eb9` |
| `apps`(browse) | `ea1b5e417c95ceb5c7d6a65aa4613a417ed80b1a8d6a8c26b6953846da1fc513` |
| `apps`(search) | `5ae1cfe2e04debdcd81279b5559313abab7d9cfa3ac9d9c048e969b3d445dcb9` |
| `appMetaData` | `cf8b620dfd03617017ba7c858cee65197e1ace5180e41be194b39227227ced63` |
| `AddOwnedVariant`(mutation) | `02b373dd20366da6a7184c16a8a84505cc3d15e9f35788c0104c4d16456bcfaf` |
| `userAccount`(LCARS側) | `39fa5dbf8c14ac4c873857fd510f337cdc8710d5614038a0625487d41f98986b` |

- **HTTP 400が返ったらインライン`query=`パラメータ付きで再試行するフォールバック実装あり**
  (ハッシュは公式クライアント更新でローテーションされうるため)= `gfn.rs:2270-2340` `fetch_panels_document`、`lcarsGraphql.ts:404-540`
- レート制限: HTTP 429 → `Retry-After`(なければ60秒)コア全体クールダウン(`docs/core-protocol.md`、`store_requests.rs`)

### 4.3 LCARS GraphQL
```
GET https://apps.gxn.nvidia.com/graphql?requestType=userAccount&extensions={persistedQuery:39fa…}&variables={}&huId={sha256(userId)hex}
```
→ `data.userAccount.storesData[]`(リンク済みストア: STEAM/EPIC/GOG/UBISOFT/…)。`account_connections.rs:17-88`

### 4.4 vpcId(すべてのGraphQL/MES呼び出しに必要)
```
GET {streamingBase}v2/serverInfo   # lcars_headers(NATIVE, NVIDIA-CLASSIC)
→ requestStatus.serverId = vpcId   # 例 "GFN-PC"
```
- 5分キャッシュ、失敗時は前回値を30秒、無ければ `"GFN-PC"` フォールバック(`server_vpc_cache.rs`、`gfn.rs:1661-1701`)

---

## 5. 購読情報(MES)

```
GET https://mes.geforcenow.com/v4/subscriptions?serviceName=gfn_pc&languageCode=en_US&vpcId={vpcId}&userId={userId}
Headers: lcars_headers(§10.2)。identifyAsSteamDeck=true にすると Steam Deck用解像度カタログ(90fps含む)が返る
```
→ `membershipTier`(FREE/PRIORITY/…)、`allottedTimeInMinutes`/`purchasedTimeInMinutes`/`rolledOverTimeInMinutes`/`remainingTimeInMinutes`、
`features.resolutions[]`(isEntitled, widthInPixels, heightInPixels, framesPerSecond)、
`addons[]`(type=STORAGE, subType=PERMANENT_STORAGE で永続ストレージ判定)
- 出典: `gfn.rs:1500-1600`、Electron: `subscription.ts:16,105`
- **実測メモ(2026-09-28)**: MESはトークンを実検証する(`401 {"error":"unauthorized","message":"invalid token"}`)。
  一方 `v2/serverInfo` は**無認証でも200**(java-provision-manager の公開メタデータ)、
  GraphQLも `__typename` introspection は無認証で通る。
  → **トークン有効性の検証にはMES(または実データのGraphQLクエリ)を使うこと**

---

## 6. CloudMatch セッション API(核心)

### 6.1 ベースURL
- 既定: `https://prod.cloudmatchbeta.nvidiagrid.net/`(`cloudmatch.rs:16`)
- ゾーン別: `https://{zoneId小文字}.cloudmatchbeta.nvidiagrid.net/`(例 `np-tyo-01` 東京、`np-lax-01`、`np-ams-08`)— `shared/gfn/endpoints.ts:16-24`。`NP-*`が標準ゾーン、`NPA-*`がアライアンス
- パートナー変種: `*.geforcenow.nvidiagrid.net`(例 `prod.bpc.…`, `th.bpc.…`)
- 作成前、既定ホストの場合は必ず `v2/serverInfo` でリージョン基に解決し直す(`resolve_create_base`、`cloudmatch.rs:717-751`)。`np-` プレフィックス基は作成時に回避
- セッション確立後は `connectionInfo` から学習した **serverIp直アドレス**(`https://{serverIp}/…`)に切替

### 6.2 エンドポイント
| メソッド | パス | 用途 | 出典 |
|---|---|---|---|
| GET | `{base}v2/serverInfo` | リージョン発見。`metaData[]`の`local-region`、`gfn-regions`(カンマ列)、各リージョン名→URL。`requestStatus.serverId`=vpcId | `cloudmatch.rs:1575`、`gfn.rs:1462` |
| GET | `{base}v2/session` | アクティブセッション一覧(全リージョン並列探索、最大32基・12秒デッドライン) | `cloudmatch.rs:440-465` |
| POST | `{base}v2/session?keyboardLayout={en-US等}&languageCode={en_US等}` | **セッション作成**(body=§6.3) | `cloudmatch.rs:75-95` |
| GET | `{base}v2/session/{sessionId}?…` | ポーリング。408/425/429/500/502/503/504は250→750msバックオフで2回リトライ | `cloudmatch.rs:684-715` |
| PUT | `{base}v2/session/{sessionId}?keyboardLayout&languageCode` | RESUME(`{"action":2,"data":"RESUME","sessionRequestData":{…}}`)。作成直後の互換性PUT、及び再接続(claim)時 | `cloudmatch.rs:118-152, 532-560` |
| PUT | `{base}v2/session/{sessionId}` | 広告レポート(`{"action":6,"adUpdates":[{adId,adAction(1start/2pause/3resume/4finish/5cancel),clientTimestamp,watchedTimeInMs,…}]}`)— 無料枠の広告視聴用 | `cloudmatch.rs:568-640` |
| DELETE | `{base}v2/session/{sessionId}` | セッション終了(404は成功扱い) | `cloudmatch.rs:285-295` |

### 6.3 作成リクエストボディ(`build_create_body`、`cloudmatch.rs:886-994`)
```jsonc
{ "sessionRequestData": {
    "appId": 12345,                       // 数値の launch appId(文字列不可)
    "externalAppId": null, "internalTitle": "Game Title",
    "availableSupportedControllers": [2], "preferredController": 2,
    "networkTestSessionId": null, "parentSessionId": null,
    "clientIdentification": "GFN-PC",
    "deviceHashId": "{UUID}",             // 永続デバイスID
    "clientVersion": "30.0", "sdkVersion": "2.0", "streamerVersion": "14",
    "clientPlatformName": "windows",      // platform_name(settings)
    "clientRequestMonitorSettings": [{
      "monitorId":0,"positionX":0,"positionY":0,
      "widthInPixels":1920,"heightInPixels":1080,"framesPerSecond":60,
      "sdrHdrMode":0,"displayData":{…HDR時は輝度情報…},"hdr10PlusGamingData":null,"dpi":96 }],
    "useOps": true, "audioMode": 2,
    "metaData": [
      {"key":"ClientImeSupport","value":"0"},
      {"key":"SubSessionId","value":"{uuid}"},
      {"key":"clientPhysicalResolution","value":"{\"horizontalPixels\":1920,\"verticalPixels\":1080}"},
      {"key":"networkType","value":"Unknown"},
      {"key":"wssignaling","value":"1"},          // ← WebSocketシグナリング要求
      {"key":"surroundAudioInfo","value":"2"} ],
    "sdrHdrMode": 0, "clientDisplayHdrCapabilities": null,
    "surroundAudioInfo": 0, "remoteControllersBitmap": 0,
    "clientTimezoneOffset": -32400000,             // ms(UTC - ローカル)
    "enhancedStreamMode": 0, "appLaunchMode": 0,
    "secureRTSPSupported": true, "partnerCustomData": null,
    "accountLinked": false, "enablePersistingInGameSettings": true,
    "requestedAudioFormat": 0, "userAge": 25,
    "requestedStreamingFeatures": {
      "codec": 0,             // 0=auto(サーバー決定) 1=H264 2=H265/HEVC 3=AV1 (cloudmatch.rs:1746)
      "maxBitrateKbps": 75000, "bitDepth": 0, "chromaFormat": 0,  // colorQuality: 8bit_420→(0,0), 10bit_420→(1,0)
      "reflex": false, "cloudGsync": false, "enabledL4S": false,
      "supportedHidDevices": 0, "profile": 0, "fallbackToLogicalResolution": false,
      "prefilterMode": 0, "prefilterSharpness": 0, "prefilterNoiseReduction": 0,
      "hudStreamingMode": 0, "vsync": false, "audioChannelCount": 2,
      "mouseMovementFlags": 0, "trueHdr": false, "hidDevices": null,
      "qosPolicy": 0, "touchSupport": false, "dynamicStreamingMode": 0 },
    "transport": null } }
```
- fps範囲 30–240、bitrate 1–200Mbps、HDRは codec∈{2,3} かつHWデコード時のみ
- REFLEXは cloudGsync ON または fps≥120 で自動ON

### 6.4 レスポンス→セッション情報抽出(`session_info`、`cloudmatch.rs:994-1140`)
| フィールド | 意味 |
|---|---|
| `session.sessionId` / `subSessionId` | セッションID(シグナリングの pairing_id) |
| `session.status` | **1=preparing, 2=ready, 3=streaming, 4/5=paused, 6=終了系**(2..=5はRESUME可) `cloudmatch.rs:1695` |
| `session.connectionInfo[]` | `{usage, ip, port, resourcePath, appLevelProtocol}` — **usage 14=シグナリング、2/17=メディア、16 or appLevelProtocol 6=RTSP** |
| `session.sessionControlInfo.ip` | コントロールプレーンのホスト |
| `session.iceServerConfiguration.iceServers[]` | `{urls[], username, credential}` — **WebRTCのRTCIceServerにそのまま渡す**。空なら STUN フォールバック: `stun:s1.stun.gamestream.nvidia.com:19308`, `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`(`cloudmatch.rs:1608`) |
| `session.queuePosition` / `seatSetupInfo` / `sessionProgress` / `progressInfo` | 待ち行列位置 |
| `session.negotiatedStreamProfile.codec` | 確定コーデック("H264"/"H265"/"AV1") |
| `session.finalizedStreamingFeatures` | サーバー確定ストリーム特徴 |
| `session.serverLocation` / `gpuType` | サーバー所在地/GPU種別 |
| `session.sessionAds[]` | 無料枠広告(adId等 → PUT action:6 で報告) |
| 導出: `signalingUrl` | `wss://{serverIp}:443{resourcePath|/nvst/}`(resourcePathが`rtsps://host:port`形なら`wss://host:port`に変換) `cloudmatch.rs:1676-1693` |
| 導出: `rtspsEndpoints[]` | `rtsps://{ip}:{port}`(既定ポート322)— ネイティブNVST用(Web版では不使用) |
| その他エラー | 409系: `otherUserSessions[]` 付きセッション競合(既存セッションのresume/stop誘導) `cloudmatch.rs:320-355` |

### 6.5 CloudMatch共通ヘッダ(`cloudmatch_headers`、`cloudmatch.rs:1243-1266`)
```
User-Agent: GFN-PC/30.0 ({platform}) BifrostClientSDK/4.9 (38495286)   # bifrost_user_agent
Authorization: GFNJWT {id_token優先、無ければaccess_token}
Content-Type: text/plain            # ← Rust版はtext/plain。Electron版はapplication/json(cloudmatch.ts)
nv-client-id: ec7e38d4-03af-4b58-b131-cfb0495903ab   # LCARS_CLIENT_ID(Electron版はrandomUUIDでも可)
nv-client-streamer: NVIDIA-CLASSIC
nv-client-type: NATIVE
nv-client-version: 2.0.87.131        # GFN_CLIENT_VERSION
nv-device-os: WINDOWS|MACOS|LINUX / nv-device-type: DESKTOP / nv-device-make: GENERIC / nv-device-model: PC
x-device-id: {deviceHashId}
x-nv-client-identity: {User-Agentと同値}
```
※ `regions()`(serverInfo)だけは `lcars_headers(token,"BROWSER","WEBRTC",…)` を使う箇所あり(`gfn.rs:1462-1497`)

---

## 7. NVSTシグナリング(WebSocket)— ブラウザ版の要

出典: Electron `main/platforms/gfn/signaling.ts`(全文365行、JSなのでほぼそのままブラウザ移植可)

### 7.1 接続
```
URL: wss://{serverIp}:443/nvst/sign_in?peer_id=peer-{rand10桁}&version=2&peer_role=1&pairing_id={sessionId}
     (session_infoのsignalingUrlが優先。pathname末尾に sign_in を付与)
WebSocketサブプロトコル: x-nv-sessionid.{sessionId}
[Electron版の追加ヘッダ] Origin: https://play.geforcenow.com / User-Agent: GFN UA
  → ブラウザはWSにカスタムヘッダを付けられない。サーバー側がOriginを検査するかはPhase 0検証項目(§15)
```

### 7.2 メッセージ形式(JSONテキスト)
| メッセージ | 方向 | 内容 |
|---|---|---|
| `{ackid, peer_info:{browser:"Chrome",browserVersion:"131",connected:true,id:0,name:"{peerName}",peerRole:0,resolution:"1920x1080",version:2}}` | → サーバー | 接続直後に送信。サーバーが`peer_info.id`を割り当てて返す |
| `{ack: ackid}` | 双方向 | 相手メッセージの応答確認(自分のpeer_infoエコーにはackしない) |
| `{hb: 1}` | 双方向 | ハートビート(5秒間隔。受信したら即り返す) |
| `{error: "peerRemoved"}` | ← | 切断扱い |
| `{peer_msg: {from, to, msg: "<JSON文字列>"}}` | 双方向 | 実ペイロードの搬送。`msg`内JSONのtype別処理は下記 |
| `msg = {type:"offer", sdp}` | ← サーバー | **サーバーがSDPオファーを送る**(クライアントはオファーを作らない) |
| `msg = {type:"answer", sdp, nvstSdp}` | → サーバー | クライアントのアンサー+**nvstSdp**(§8.3) |
| `msg = {candidate, sdpMid, sdpMLineIndex, usernameFragment}` | 双方向 | ICE候補(TCP候補はクライアント側で破棄) |
| `msg = {type:"request_keyframe", reason, backlogFrames, attempt}` | → | キーフレーム再要求(デコード詰まり時) |
| `msg = "BYE"` | ← | セッション終了 |

---

## 8. ブラウザ側WebRTC実装(v0.5.5 renderer が完全な先行実装)

出典: `renderer/src/platforms/gfn/webrtcClient.ts`(2461行)ほか

### 8.1 RTCPeerConnection構成(`webrtcClient.ts:2014-2020`)
```ts
const pc = new RTCPeerConnection({
  iceServers: session.iceServers,     // CloudMatchレスポンス由来(urls/username/credential)
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
});
```

### 8.2 DataChannel(`webrtcClient.ts:1570-1650`)
| ラベル | オプション | 用途 |
|---|---|---|
| `stats_channel` | `{ordered:false, maxRetransmits:0}` | サーバー→クライアントの統計(バイナリ。fps等) |
| `input_channel_v1` | `{ordered:true}` | 信頼入力(キー等)+ 入力能力ハンドシェイク(RI: hidDeviceMask, partiallyReliableThresholdMs 等を交渉) |
| `input_channel_partially_reliable` | `{ordered:false, maxPacketLifeTime:{threshold}ms}` | マウス相対移動など低遅延入力 |
| `cursor_channel` | `{ordered:true}` | 任意(クライアント側カーソルオーバーレイ時) |

入力パケット(バイナリ、`packetEncoding.ts`): type= 2 heartbeat / 3 key down / 4 key up / 5 mouse abs / 6 lock-keys sync / 7 mouse rel / 8,9 mouse button down/up / 10 wheel / 12 gamepad / 13 haptics / 23 text。
スキャンコード変換: `keyboardScancodes.ts`、ゲームパッド: `gamepadMapping.ts`、クリップボード: `clipboardProtocol.ts`、マイク: `microphoneManager.ts`(RTCPeerConnectionにaudio送信を追加)

### 8.3 SDPフロー(`webrtcClient.ts:2200-2320` + `sdp/nvstOffer.ts`)
1. シグナリングでサーバーOFFER受信 → コーデック別SDP処理(HEVC level-id/tier-flag書き換え、`preferCodec`でH264/H265/AV1優先順位付け、フォールバック交渉)
2. `createAnswer` → `mungeAnswerSdp`(b=AS:{maxBitrateKbps}、stereo=1)→ `setLocalDescription`
3. ローカルSDPからICE資格情報(ufrag/pwd/DTLS fingerprint)を抽出し **nvstSdp** を生成:
   - `buildNvstSdp`(`sdp/nvstOffer.ts`)— **公式 play.geforcenow.com のSDPとバイト単位で整合**させたカスタムSDP風テキスト
   - `a=general.icePassword/iceUserNameFragment/dtlsFingerprint`、解像度/fps/codec/bitrate(最低4000kbps)/colorQuality(8|10bit)/hidDeviceMask/split-encode設定等を記述
4. `{type:"answer", sdp, nvstSdp}` をシグナリングで送信 → ICE候補交換(answer送信前に溜めた候補をフラッシュ)

### 8.4 ネイティブ版との違い(参考)
現行Qt版はWebRTCではなく **NVST over RTSP/WSS + 独自SRTP/UDP(str0m)** を使用:
`wss://{host}:{port}/rtsp` でRTSPハンドシェイク(`nvst_rtsp.rs:120`)→ SRTP AES-GCM(8バイトタグ, libBifrost2準拠)映像+Opus音声。
**ブラウザ版では不要**(§7-8のWebRTC経路が正)。ただし native/opennow-streamer はNVSTパケット仕様のリファレンスとして有用。

---

## 9. アカウントリンク(ALS)/ ストレージ / その他

### 9.1 ゲームストア連携(`account_connections.rs`、Electron `accountConnections.ts`)
```
GET    https://als.geforcenow.com/v1/login_url?platform={provider}&redirect_uri=http://localhost:{port}/&client_id=gfn-pc
       → { login_url }  (ブラウザで開く。完了後 static-als.nvidia.com/result?platform=… に着地)
POST   https://als.geforcenow.com/v1/sync/{provider}       body:{} → 202 で成功(ライブラリ同期開始)
DELETE https://als.geforcenow.com/v1/linking/{provider}    (unlink。404は成功扱い)
```
- ヘッダ: `Authorization: Bearer {token}` + Origin/Referer play.geforcenow.com(`als_headers`、GFNJWTではない点に注意)
- provider例: STEAM / EPIC / GOG / UBISOFT / EA / BATTLENET 等(`provider_definitions`)
- 链接状態取得は §4.3 のLCARS GraphQL(userAccount)

### 9.2 永続ストレージ / paywall(`persistent_storage.rs`)
```
GET  https://api-prod.nvidia.com/gfn-paywall-api/api/v2/products?locale={en_US}&vpcId={vpcId}
POST https://api-prod.nvidia.com/gfn-paywall-api/api/v2/reset/storage?storageRegion={region|null}
Headers: Accept/Content-Type: application/json + idtoken: {token}   # 独自ヘッダ"idtoken"
```
※ 401/403時は「Webアカウントセッションが必要」(idToken要件)エラーになる旨の分岐あり

### 9.3 運用状況 / アートワーク / 計測
```
GET https://status.geforcenow.com/api/v2/components.json     # GFN障害情報(persistentStorage.ts:14)
画像CDN: https://img.nvidiagrid.net/apps/…                    # GraphQLレスポンス内のimageUrl/keyArtUrl等
Steam代替アート: https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg 等
Gravatar: https://www.gravatar.com/avatar/{md5(email)}
リージョンping: ゾーンホスト:443 へのTCP接続時間(3回平均)    # network.rs:11-110 — HTTP APIではない
```

### 9.4 OpenNOWコミュニティ系(参考・移植不要)
- `https://api.printedwaste.com/gfn/queue/`(コミュニティ混雑統計)
- `https://opennow-proxy-production.up.railway.app/api/public/proxy`(コミュニティ提供の出口プロキシ。provision APIで認証情報を発行)— **「Webクライアント用にプロキシを別ホストする」先行事例**(§14参照)
- PostHog(`eu.i.posthog.com/capture/`)とバグレポート(`api.printedwaste.com`)はOpenNOW独自テレメトリ

---

## 10. ヘッダ早見表

### 10.1 User-Agent
| 定数 | 値 | 使用先 |
|---|---|---|
| `STEAM_DECK_USER_AGENT` | `Mozilla/5.0 (X11; Linux x86_64; Steam Deck) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36` | login.nvidia.com系 |
| `GFN_USER_AGENT`(Rust) | `Mozilla/5.0 (X11; Linux x86_64) … NVIDIACEFClient/HEAD/7b92719716 GFN-PC/2.0.87.131` | pcs/static.nvidiagrid |
| `GFN_WINDOWS_USER_AGENT`(TS) | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … NVIDIACEFClient/HEAD/debb5919f6 GFN-PC/2.0.80.173` | Electron全般 |
| Bifrost UA | `GFN-PC/30.0 ({platform}) BifrostClientSDK/4.9 (38495286)` | CloudMatch |

### 10.2 lcars_headers(GraphQL/MES用、`gfn.rs:2529-2588`)
```
Accept: application/json, text/plain, */*
Authorization: GFNJWT {token}
nv-client-id: ec7e38d4-03af-4b58-b131-cfb0495903ab
nv-client-type: NATIVE|BROWSER / nv-client-version: 2.0.87.131 / nv-client-streamer: NVIDIA-CLASSIC|WEBRTC
nv-device-os: WINDOWS|MACOS|LINUX|STEAMOS / nv-device-type: DESKTOP|CONSOLE / nv-device-make: GENERIC|VALVE / nv-device-model: PC|STEAMDECK
x-nv-client-identity: GFN-PC
User-Agent: {GFN_USER_AGENT}
```
graphql_headers は上記 + `Content-Type: application/json`(persisted時は`application/graphql`)+ `Origin/Referer: play.geforcenow.com` + `nv-browser-type: CHROME`(`gfn.rs:2514-2528`)

### 10.3 認証スキームまとめ
| スキーム | 使う先 |
|---|---|
| `Authorization: GFNJWT {id_token∥access_token}` | GraphQL(games.geforce.com / apps.gxn.nvidia.com)、MES、CloudMatch |
| `Authorization: Bearer {access_token}` | login.nvidia.com(userinfo/client_token/token)、ALS |
| `idtoken: {token}`(独自ヘッダ) | gfn-paywall-api |
| なし | pcs serviceUrls、static.nvidiagrid.net、status |

---

## 11. Qt↔コアJSON-RPCメソッド名(`docs/core-protocol.md`)— WebアプリAPI設計の雛形に

```
auth.providers.list / auth.device.start / auth.device.poll / auth.device.complete / auth.device.cancel
auth.session.get / auth.logout / auth.accounts.{list,switch,remove,logoutAll} / auth.pin.{set,verify,clear,status}
catalog.library.list / catalog.public.list / catalog.store.list / catalog.store.presentation / catalog.store.local
account.subscription.get / account.connections.{list,sync,unlink,link.start,link.poll} / account.storage.{locations,reset}
network.regions.list / network.regions.ping
session.create / session.poll / session.claim / session.stop / session.active.get / session.remote.list / session.ad.report
settings.{get,set,reset} / media.* / diagnostics.* / updater.* / core.hello
```
(トランスポート: 改行区切りJSON・1MiB上限・最大8並列ワーカー/うち4バックグラウンド・429クールダウン)

---

## 12. ブラウザ版(Render)へ移植するファイルリスト(すべてMIT)

| 移植元(v0.5.5 / main) | 移植先 | 備考 |
|---|---|---|
| `main/platforms/gfn/auth/constants.ts` | バックエンド定数 | エンドポイント/client_id/scopes |
| `main/platforms/gfn/auth/deviceLogin.ts` + Rust `gfn.rs:455-680` | `/api/auth/*` プロキシ | ヘッダ偽装はサーバー側で可能 |
| `main/platforms/gfn/clientHeaders.ts` | プロキシのヘッダ生成 | そのまま流用可 |
| `main/platforms/gfn/cloudmatch.ts` + Rust `cloudmatch.rs` | `/api/session/*` プロキシ | create/poll/resume/stop/claim/ad |
| `main/platforms/gfn/lcarsGraphql.ts`、Rust `gfn.rs:36-210`(クエリ全文) | `/api/catalog/*` プロキシ | persisted hash + 400時インラインフォールバック |
| `main/platforms/gfn/subscription.ts` | `/api/subscription` | MES |
| `main/platforms/gfn/signaling.ts` | ブラウザ直結 or Render WSリレー | §14参照 |
| `renderer/src/platforms/gfn/webrtcClient.ts` | ブラウザ(ほぼ流用) | Electron IPC(`window.openNow.*`)を自分のAPI/WSに置換 |
| `renderer/src/platforms/gfn/sdp/nvstOffer.ts`、`sdp/*.ts` | ブラウザ | そのまま流用可 |
| `renderer/src/platforms/gfn/{inputProtocol,packetEncoding,keyboardScancodes,keyboardMapping,gamepadMapping,mouseInput,cursorChannel,clipboardProtocol}.ts` | ブラウザ | 入力系一式 |
| `main/platforms/gfn/accountConnections.ts`、`paywall.ts`、`persistentStorage.ts` | 任意(Phase 5) | ストア連携・ストレージ |

---

## 13. 設計上の含意(Render構成への反映)

1. **CORS**: NVIDIA系APIはサードパーティOriginを許可していない → 全HTTP APIはRenderバックエンドがプロキシ(前設計書§1の構成で正しい)。Electronも同じ理由でmainプロセス経由だった。
2. **ブラウザから直接叩ける可能性があるもの**: NVSTシグナリングWSS(WebSocketはCORS対象外だがOriginヘッダは自動送信され偽装不可)とWebRTCメディア(問題なし)。
3. **認証はデバイスフロー一択**: 認可コードフローのredirect_uriはlocalhostホワイトリスト前提のためWebでは使えない。デバイスフロー(QR/user_code)ならRenderプロキシで完結する。
4. **ステートレス化の好機**: OpenNOWはトークンをOSキーチェーンに保存するが、Web版では「セッション中のみサーバー側Redis(TTL)」に留め、リフレッシュはclient_token grantで行う設計が安全。
5. **vpcId・serverInfoは5分キャッシュ**でNVIDIA側レート制限に配慮(429→Retry-After遵守)。
6. **コミュニティプロキシの前例**: OpenNOW公式がRailway上で出口プロキシを運用していた実績があり、「軽量ホスト+プロキシ」構成自体は実運用に耐える。

---

## 14. Phase 0 残検証チェックリスト(実機確認が必要)

- [ ] **NVST WSSのOrigin検査**: ブラウザ(自サイトOrigin)から `wss://{serverIp}/nvst/sign_in` に直接接続できるか。
      拒否されるならRenderにWSリレー(ブラウザWS↔サーバーWS、ヘッダ差し替え)を実装
- [x] **デバイスフロー現行性**: ✅ 2026-09-28 に Phase 1 MVP(`gfn-web-mvp/`)で実機確認済み。
      `STEAM_DECK_CLIENT_ID` + Steam Deckヘッダ一式で `device/authorize` が 201 相当(user_code発行)を返す。
      `verification_uri` は `https://static-login.nvidia.com/service/gfn/pin`(login.nvidia.com/device ではない点に注意)。
      有効期限900秒・interval 5秒・poll は `authorization_pending` → トークン交換はユーザー承認が必要なため未検証
- [ ] **persisted queryハッシュの鮮度**: 400が返る場合はインラインクエリへのフォールバックで全カタログAPIが通るか
- [ ] **`nv-client-version` の許容範囲**: 2.0.80.173 / 2.0.87.131 のどちらを要求各APIが受理するか
- [ ] **ゾーン選択**: `v2/serverInfo` の `local-region`/`gfn-regions` から日本ユーザーが `np-tyo-*` を選べるか、TCP pingで最適ゾーンを選ぶ実装の検証
- [ ] **無料枠の広告フロー**: `sessionAds` + PUT action:6 の実地確認(無料アカウントで検証時)
- [ ] **セッション競合(409 otherUserSessions)**: resume/stop UXの設計材料として実機確認
- [ ] **WebRTCコーデック**: Chrome最新版でのH264/HEVC/AV1ネゴシエーション(SDP mungingの再検証、`webrtcClient.ts:2200-2260`のHEVC level/tier処理)
- [ ] **`/redirect` エンドポイント**: `prod.cloudmatchbeta.nvidiagrid.net/redirect` はテストコードにのみ登場。用途不明(おそらくゾーン間リダイレクト)— 実運用では不要と思われるが要確認
- [ ] **BPC系ホスト**: `*.bpc.geforcenow.nvidiagrid.net`(例: th.bpc)はパートナーゾーン用。日本ユーザーに関係するか要確認

---

## 15. 法務・規約メモ(再掲)

- 本一覧はすべてMITライセンスの公開ソースからの抽出であり、NVIDIA公式APIドキュメントではない
- 非公式クライアントでのGFN利用はNVIDIA利用規約に抵触しうる(アカウントリスク)。検証はサブアカウント推奨
- ヘッダのUser-Agent/Origin偽装(Steam Deck/公式Web客户端を装う)は interoperability のための既存実装踏襲だが、
  公開サービス化時はリスク評価を行うこと(本資料は法的助言ではない)
- エンドポイント・ハッシュ・client_idはNVIDIA側の更新で随時壊れる。OpenNOW本体(main/dev ブランチ、Discord)を継続ウォッチすること
