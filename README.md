# gfn-web-mvp — Phase 1(認証プロキシ + ライブラリ表示)

OpenNOW(MIT)解析に基づく **GeForce NOW 非公式WebクライアントのMVP**。
設計書: [`docs/OpenNOW風サイトをRenderで作る設計書.md`](docs/OpenNOW風サイトをRenderで作る設計書.md) / エンドポイント一覧: [`docs/Phase0_GFNエンドポイント一覧.md`](docs/Phase0_GFNエンドポイント一覧.md)

> **動作実績(2026-09-28)**: 実アカウントでのログイン → ライブラリのゲームタイトル表示まで成功。
> デバイスフロー認証・GraphQLライブラリ・MES購読・アートワークCDNの現行有効性を実機確認済み。

Phase 1 のスコープ:

- ✅ NVIDIA ID **デバイスフロー認証**のプロキシ — **QRコード** / **コード手入力**(スマートフォン不要)の2方式
- ✅ **トークンインポート**(公式 play.geforcenow.com のセッションJWTを貼り付け、MES APIで実検証)
- ✅ トークン管理(access/refresh/id/client_token、期限前自動リフレッシュ)
- ✅ **ライブラリ表示**(GraphQL `GetLibraryApps`、cursorページネーション、検索)
- ✅ **購読情報**(MES: tier/残り時間/解像度権限)とリージョン表示(v2/serverInfo)
- ✅ レート制限・HttpOnly Cookie・アップストリームエラー正規化

Phase 2A のスコープ(映像受信まで):

- ✅ **CloudMatchセッションAPI**(`POST/GET/PUT/DELETE v2/session`、RESUME、競合検出とリモート停止)
- ✅ **NVSTシグナリングWSリレー**(`/ws/signaling` ↔ `wss://{serverIp}:443/nvst/sign_in`)
  — ブラウザWSはカスタムヘッダを送れないため、サーバー側でOrigin/UA/サブプロトコルを公式相当に差し替えて中継
- ✅ **WebRTC映像受信**(サーバーOFFER → ANSWER+**nvstSdp**(公式Webクライアントとバイト整合の属性セット)→ ICE交換 → `<video>`表示)
- ✅ DataChannel開設(`stats_channel` / `input_channel_v1` / `input_channel_partially_reliable`)+ 2秒間隔ハートビート
- ✅ 起動設定(解像度/フレームレート/ビットレート/キーボード配列/ゲーム内言語)、統計オーバーレイ(RTT/ビットレート/解像度)、待機行列表示
- ✅ **サーバーリージョン選択**(起動モーダルから `v2/serverInfo` のリージョン一覧を選択、
  都市名の推定表示・★local マーク・no-cors fetchによる遅延計測ボタン付き。選択はlocalStorageに保存され、
  明示指定時はそのゾーン基(例 `np-tyo-01.cloudmatchbeta.nvidiagrid.net`)へ直接セッション作成)
- ✅ **無料枠のキュー広告フロー**(旧Electron版 useQueueAdRuntime/queueAds の簡約移植):
  待機行列中(`seatSetupStep=1` または `queuePosition>1`)に `sessionAdsRequired` なら
  広告ビデオを自動再生し、`start/pause/resume/finish` を `PUT v2/session/{id}` (action:6) で報告。
  再生失敗/30秒無応答は `cancel`(errorInfo付き)でスキップ報告し通常キューへ。
  広告リストは作成直後のpollでしか届かないため、サーバー側で前回リストを保持(mergeAdStateForPoll)。
  自動再生ブロック時は「広告を再生」ボタンを表示
- ⛔ **入力送信(キー/マウス/ゲームパッド)はPhase 2B**。映像視聴のみで操作不可
- ⛔ HEVC/AV1は未検証(H264優先固定)、ストア連携(Phase 5)

> **免責**: NVIDIA非公式クライアントです。GeForce NOW利用規約に抵触する可能性があり、
> アカウントリスク・API仕様変更による破損リスクがあります。検証はサブアカウントで。

---

## ログイン方法(3方式)

| 方式 | 流れ | 長所 | 短所 |
|---|---|---|---|
| **① QRコード**(既定) | 「サインインを開始」→ スマートフォンでQRスキャン → NVIDIA公式ページで承認 | 一番手軽。2FA/CAPTCHAはNVIDIA側が処理 | スマートフォンが必要 |
| **② コード手入力** | 「コードを手入力」タブ → 表示された8桁コードをコピー → 同じ端末で開いたNVIDIA公式PINページ(`static-login.nvidia.com/service/gfn/pin`)に入力 | スマートフォン不要。Steam/GoogleアカウントでのログインもNVIDIA側ページから選択可 | タブを行き来する |
| **③ トークンインポート** | 公式 play.geforcenow.com にログイン → DevToolsでLocalStorageからJWTをコピー → 本アプリに貼り付け | デバイスフローが通らない環境の最終手段 | 手動でトークン採取が必要。**自動リフレッシュ不可**(exp切れで再インポート)。トークン=アカウント資格情報扱い |

**①②は同じOAuthデバイスフロー**(RFC 8628)のUI違いで、パスワードは一切このサーバーを通りません。
承認完了までサーバー側は `authorization_pending` をポーリングします。

**「メールアドレス+パスワード直接入力」を実装しない理由**:
パスワードを第三者サーバーに渡すこと自体が重大なセキュリティリスクであり、加えてNVIDIAのログイン
フォームはCAPTCHA・2FA・bot検出で保護されているためプロキシ実装は技術的にも破綻します。
OpenNOW本体(デスクトップ/モバイル)も同様の理由でデバイスフロー/OAuthのみを採用しています。

**トークンインポートの検証の仕組み**: 貼り付けられたJWTは構造/期限チェック後、**MES購読API
(`mes.geforcenow.com`)への実呼び出しで検証**します。MESは偽造・失効トークンを401で拒否します
(2026-09-28実測。`v2/serverInfo`やGraphQL introspectionは無認証でも200を返すため検証に使えません)。

---

## アーキテクチャ

```
ブラウザ(public/) ──同一オリジン HTTP/WS──▶ Fastify(src/) ──HTTPS──▶ NVIDIA各API
   │                                          │  ・login.nvidia.com   (OAuth device flow)
   │  QR/コード入力・ライブラリUI               │  ・pcs.geforcenow.com (providers)
   │                                          │  ・games.geforce.com  (GraphQL catalog)
   │  /ws/signaling (NVSTシグナリング中継)      │  ・mes.geforcenow.com (subscription)
   │ ◀───────────────────────────────────────▶ │  ・{zone}.cloudmatchbeta.nvidiagrid.net
   │                                          │      (v2/session = CloudMatch セッションAPI)
   │  WebRTC: 映像/音声/DataChannel            │  ・wss://{serverIp}:443/nvst/sign_in
   │ ◀════════ GPUサーバーと直接通信 ═════════▶ │      (Origin/UA/サブプロトコルを中継時に付与)
   │   ※メディアはPaaSを経由しない
      Cookie: gfnweb_sid (HttpOnly)            └─ セッション/アクティブセッションはプロセス内メモリ
                                                  ※NVIDIAトークンはブラウザに一切返さない
```

- **CORS**: NVIDIA側APIはサードパーティOriginを拒否するため、すべてのHTTPはサーバー側プロキシ経由
- **シグナリング**: ブラウザのWebSocket APIはカスタムヘッダを送れないため、
  `/ws/signaling` でサーバーが中継し、上流に `Origin: https://play.geforcenow.com` /
  GFN User-Agent / サブプロトコル `x-nv-sessionid.{sessionId}` を付与する
- **メディア**: 映像・音声・入力はブラウザ↔GPUサーバーの直接WebRTC。PaaSの帯域は消費しない

## ローカル起動

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # --watch 付き
npm test           # マッピング/プロバイダ/serverInfo のユニットテスト
```

## Render デプロイ

1. このフォルダをGitリポジトリ化してGitHubへ push
2. Render Dashboard → **New + → Blueprint** → リポジトリ接続(`render.yaml` が自動適用)
   - または **New + → Web Service** 手動設定: Build `npm ci` / Start `npm start` / Health `/healthz`
3. リージョンは **Singapore**、プランは Free で動作(15分無通信でスピンダウン → 初回アクセスが約50秒遅延。
   常用するなら Starter $7/mo)
4. デプロイ後 `https://<your-app>.onrender.com` を開き、QRでサインイン

## Railway デプロイ

Railwayは3通りのデプロイ方法があります(いずれも `PORT` は自動注入、HTTPSは自動付与)。

### 方法A: ダッシュボード(ゼロコンフィグ・最簡単)

1. [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** でこのリポジトリを選択
2. Railpack(Node自動検出)が `npm install` → `npm start` を実行
3. サービス **Settings → Deploy → Healthcheck Path** に `/healthz` を設定
4. **Settings → Region** を `asia-southeast1-eqsg3a`(シンガポール=日本最寄り。東京リージョンは無い)に変更
5. **Settings → Networking → Generate Domain** で公開URLを発行

### 方法B: CLI(`railway up`)

```bash
npm install -g @railway/cli
railway login
railway init            # 新規プロジェクト作成(または railway link で既存に接続)
railway up              # このディレクトリをそのままデプロイ
railway domain          # 公開URL発行
```

### 方法C: Infrastructure as Code(`.railway/railway.ts` 同梱済み)

```bash
npm install -D railway          # IaC評価用パッケージ
railway login && railway link
railway config plan             # 差分プレビュー(start/healthcheck/region 定義済み)
railway config apply
```

> **注意**: 旧形式の `railway.json` / `railway.toml`(Config as Code)は**非推奨**であり、
> 新規サービスでは読み込まれません(既存サービスも2026-12-01でハードカットオフ)。
> そのため本リポジトリには含めず、後継のIaCファイル(`.railway/railway.ts`)を同梱しています。

### Render / Railway 比較

| | Render | Railway |
|---|---|---|
| 無料枠 | Freeプランあり(**15分無通信でスピンダウン**、コールドスタート~50秒) | 恒久的な無料枠なし(**30日/$5トライアル** → Trial $1/mo または Hobby $5/mo+従量) |
| 常時稼働 | Starter $7/mo | スピンダウンなし(従量課金、この規模なら月$1〜5程度) |
| 日本最寄りリージョン | Singapore | Singapore(`asia-southeast1-eqsg3a`) |
| 設定ファイル | `render.yaml`(Blueprint) | `.railway/railway.ts`(IaC)or ゼロコンフィグ ※`railway.json`は非推奨のため不使用 |
| WebSocket(Phase 2のシグナリングリレー用) | 対応 | 対応 |

**どちらでも動作する理由**: 環境変数 `PORT` のみでリッスンし、Cookie の Secure 属性は
`RENDER` / `RAILWAY_ENVIRONMENT` 環境変数の有無で自動判定(`src/server.js`)。
プラットフォーム固有の依存はありません。

**注意(両PaaS共通)**: セッションはプロセス内メモリ保存のため、**再デプロイ/再起動で全ユーザーが
ログアウト状態になります**(MVPの割り切り。Redis接続で解消可能 — `src/store.js` 参照)。
スケール(複数レプリカ)時も同様に共有ストアが必要です。

環境変数(任意):

| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 3000(Renderは自動注入) | listen ポート |
| `NODE_ENV` | — | `production` で Secure Cookie |

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/healthz` | ヘルスチェック |
| GET | `/api/providers` | ログインプロバイダ一覧(pcs serviceUrls) |
| POST | `/api/auth/device/start` | デバイスフロー開始 → `{attemptId, userCode, qrDataUrl, verificationUri, …}` |
| POST | `/api/auth/device/poll` | 承認ポーリング → `pending/slow_down/authorized/expired/access_denied` |
| POST | `/api/auth/device/complete` | 承認完了 → セッションCookie発行 |
| POST | `/api/auth/device/cancel` | 試行破棄 |
| POST | `/api/auth/token/import` | 公式WebクライアントのJWT貼り付けインポート(MESで実検証) |
| GET | `/api/session` | 現在のセッション(トークン除く) |
| POST | `/api/auth/logout` | ログアウト |
| GET | `/api/regions` | v2/serverInfo → vpcId + リージョン一覧 |
| GET | `/api/library?cursor=` | ライブラリ1ページ(200件/cursor) |
| GET | `/api/subscription` | MES購読情報 |
| POST | `/api/session/start` | CloudMatchセッション作成 `{appId, title, settings, region?}` → session info(region=リージョン基URL、省略時は自動。信頼ホスト検証あり) |
| GET | `/api/session/poll` | セッション状態ポーリング(status/queuePosition/signalingUrl/iceServers) |
| GET | `/api/session/active` | 現在のアクティブセッション |
| POST | `/api/session/stop` | セッション終了(DELETE v2/session) |
| POST | `/api/session/claim` | 既存セッションの引き継ぎ(PUT RESUME) |
| POST | `/api/session/remote/stop` | 競合(別デバイス)セッションの停止 |
| POST | `/api/session/ad` | 広告視聴状態の報告(PUT action:6) |
| WS | `/ws/signaling?sessionId=` | NVSTシグナリングリレー(認証Cookie必須)→ `wss://{serverIp}:443/nvst/sign_in` |

## トラブルシュート

### 表示が固まる/新しいボタンが出てこない → まず「ブラウザの古いキャッシュ」を疑う

**実例(2026-09-28)**: 「診断情報ボタンが表示されない」報告を受け、本番URL
(`https://gfn-web-client-production.up.railway.app`)を直接検査したところ、
**サーバーは最新コードを配信済み**(ボタン・広告ランタイム・no-cacheヘッダすべて存在)で、
原因は**ヘッダ対策前にブラウザがヒューリスティックキャッシュした古いHTML/JS**だった。

**v0.5.0 での恒久対策:**
- ヘッダーの**バージョンバッジ**(例 `v0.5.0-ui2`)とフッター表示 — UIを見れば実行中バージョンが即わかる
- 起動時の `/healthz` 照合: サーバーとクライアントのバージョン不一致を検出すると
  **赤い警告バナー**(「今すぐ再読み込み」ボタン付き、`?fresh=` クエリでキャッシュ回避)を表示
- HTML/JS/CSS は `Cache-Control: max-age=0` + `?v=N` クエリで配信(再発防止)

**対処**: ハードリロード(Ctrl+Shift+R / Cmd+Shift+R)、または URL に `?fresh=1` を付けて開く。
シークレットウィンドウで開けば確実に最新になる。

### リージョンがおかしい(遠隔地に接続される)場合

**v0.5.4で修正済み。** 原因は2つ:
1. **「自動」の地理判定がサーバー側になる問題**: すべてのNVIDIA APIはサーバー(Railway)経由のため、
   GFNの `local-region` 判定は**Railwayの出口IPの地理**(実測で India)になり、ユーザーの所在地と無関係。
   → 対策: 起動モーダルのリージョン既定値を**ブラウザのタイムゾーンから推定した推奨リージョン**
   (例: Asia/Tokyo → `Japan = https://ap-japan.cloudmatchbeta.nvidiagrid.net`)に変更。
   「自動」は非推奨ラベル付きで残置
2. **ゾンビセッションの409ループ**: 上流で失効したセッションがサーバー内メモリに残ると、
   以降の起動がすべて409競合→死んだセッションのポーリング404ループに陥っていた
   → 対策: 全候補基404で `session_gone`(410)を返しローカル状態を自動解放。
   起動時の同一タブ競合は「自動停止→1回だけ再作成」に変更。stopは上流失敗時もローカル状態を解放

### セッションが進行しない場合

1. ストリームビュー下部の「**診断パネル**」を開く(セッションの生JSONが毎秒更新される)+「診断情報」ボタンでクリップボードにコピー可能
2. 進行タイムライン(セッション作成→待機/広告→シグナリング→WebRTC接続→映像)のどこで止まっているか確認
3. `sessionInfo` の読み方:
   - `status=1, seatSetupStep=1, ads=required` → 無料枠のキュー広告フロー(広告再生/報告で自動進行)
   - `status=1, queuePosition=N` → 単純な待機行列(混雑。最大15分ポーリング)
   - `SESSION_REQUEST_IN_QUEUE_ABANDONED`(statusCode 69)→ サーバー側がキュー要求を破棄。
     混雑・キュータイムアウト・**アカウントのホームリージョンから遠いリージョンでの無料枠**で
     発生しやすい。v0.5.6で8秒間隔・最大2回の自動再試行+手動再試行ボタンを実装。
     根本対策はホームリージョン(日本なら Japan)の選択と混雑時間帯を避けること
   - `adState=null` で数分進行なし → リージョン混雑の可能性。別リージョンを選択して再試行
4. セッション作成前に、残留したキューセッション(status=1)と自デバイスの旧セッションを
   自動掃除する(他デバイスの配信中セッションは保護)
4. ポーリングループは自己回復化済み(UI更新やストリーム開始が例外を投げても停止しない)

## 既知の制限(MVP)

- セッションは**プロセス内メモリ**。再起動/スケールアウトで消失 → 次段でRender Key Value(Redis)へ差し替え
  (`src/store.js` のインターフェースを維持したまま実装交換可能)
- CSRFは SameSite=Lax Cookieに依存(公開サイト化する前に二段階トークン等を追加推奨)
- ライブラリは「読み込んだ範囲内」のクライアント側検索(全件横断検索はPhase 3のストア検索APIで)
- トークンリフレッシュはリクエスト時の遅延チェック式(バックグラウンド更新なし)
- **トークンインポートのセッションはリフレッシュ不可**(refresh_token/client_tokenを伴わないため)。
  JWTの `exp` 到達で自動的にログアウト状態になり、再インポートが必要

## 出典(MIT License — OpenCloudGaming/OpenNOW)

- `native/opennow-core/src/gfn.rs`(認証・catalog・MES)
- `native/opennow-core/src/cloudmatch.rs`(serverInfo/セッションAPI・ヘッダ)
- v0.5.5 `opennow-stable/src/main/platforms/gfn/**`(TypeScript実装)
- 詳細な行番号対応は [`docs/Phase0_GFNエンドポイント一覧.md`](docs/Phase0_GFNエンドポイント一覧.md) を参照
