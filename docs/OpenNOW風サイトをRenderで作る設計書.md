# OpenNOWのような「GeForce NOW代替サイト」をRenderで作る方法

作成日: 2026-09-28

---

## 0. 前提知識:OpenNOWとは何か

調査した結果、OpenNOWの実態は以下の通りです。

- **NVIDIA GeForce NOWの非公式・オープンソース(MITライセンス)クライアント**
  (GitHub: OpenCloudGaming/OpenNOW、約2.5k stars)
- 独自のGPUサーバーを持たない。**ゲームの実行・映像エンコードはすべてNVIDIAの
  GeForce NOWインフラ側**が行い、OpenNOWは「ログイン→ライブラリ取得→セッション
  確立→ストリーム受信」というクライアント処理をリバースエンジニアリングで再実装している
- 現行版は Qt Quick(UI)+ Rust(アカウント/カタログ/セッション処理)+ ネイティブRust
  ストリーマー(NVSTトランスポート、デコード、入力)という構成
- 旧バージョンはElectron製で、ChromiumのWebRTCを使っていた(現行Qt版には
  「Chromium/WebRTCフォールバックはない」とREADMEに記載)
- 利用には自分のGeForce NOWアカウント+サブスクリプションが必要

つまり「OpenNOWのようなサイトをRenderで作る」= **ブラウザで動くGeForce NOW
クライアントWebアプリを作り、Renderにホストする**、という話になります。
GPUはNVIDIA側なので、**RenderにGPUがなくても成立する**のが最大のポイントです。

> 別解釈として「GeForce NOWそのものの代替"サービス"(自前のGPUファーム)を作る」
> 場合はルートB(§5)を参照。RenderにはGPUインスタンスが存在しない(Feature Request
> のみ)ため、Render単体では不可能でハイブリッド構成になります。

---

## 1. 全体アーキテクチャ(ルートA:GFNクライアントサイト)

```
┌──────────────┐   ①ログイン/ライブラリ/セッション開始   ┌────────────────────┐
│   ブラウザ    │ ─────────────────────────────────────▶ │      Render        │
│ (プレイヤーUI) │   HTTP/WS (CORS回避のため必ず経由)      │  ┌──────────────┐  │
│              │ ◀───────────────────────────────────── │  │ API/シグナリ  │  │
│ WebRTC       │   ②認証トークン・SDP・ICEの仲介         │  │ ングプロキシ  │  │
│ (video要素)  │                                        │  │ (Node/Fastify)│  │
└──────┬───────┘                                        │  └──────┬───────┘  │
       │                                                 │  Redis / Postgres  │
       │ ③映像・音声・入力                                │  (セッション状態)   │
       │   WebRTC (UDP、Renderを経由しない直接通信)        └─────────┼──────────┘
       │                                                           │
       ▼                                                           │ ②'API呼び出し
┌──────────────────────┐                                           │ (サーバー側から)
│  NVIDIA GFN エッジ    │ ◀────────────────────────────────────────┘
│  サーバー (GPU)       │   GFWEB API / メディアサーバー
└──────────────────────┘
```

**設計の核心:**
1. **メディア(映像/音声/入力)はブラウザ↔NVIDIA間で直接WebRTC**。Renderは
   帯域を消費しない → 無料/低額プランでも運用可能。
2. **NVIDIAのAPIはCORSを許可していない**ため、ブラウザから直接叩けない。
   → Render上のバックエンドがプロキシ+シグナリング中継を担う。
3. Renderの役割は「認証プロキシ」「APIプロキシ」「WebRTCシグナリング中継」
   「フロントエンド配信」の4つだけ。

---

## 2. 技術スタック選定

| レイヤー | 推奨 | 理由 |
|---|---|---|
| フロントエンド | Next.js / Vite+React(静的エクスポート) | Render Static Site=全球CDN配信、リージョン不要 |
| バックエンド | Node.js + Fastify(またはPython FastAPI) | WebSocket・HTTPプロキシが書きやすくRender相性が良い |
| シグナリング | WebSocket(Renderは全プランでWS対応) | SDP/ICEの仲介に必要 |
| 映像受信 | `RTCPeerConnection` + `<video>`(recvonly) | 公式Webクライアント(play.geforcenow.com)と同じ方式。HWデコードはブラウザ任せ |
| 入力 | Pointer Lock API(マウス)+ Keyboard event + Gamepad API → WebRTC DataChannel | 公式Web版に倣う |
| 状態管理 | Render Key Value(Redis) | セッション/トークンの一時保存(TTL付き) |
| 任意の永続化 | Render Postgres | お気に入り・設定の同期(多ユーザー化するなら) |
| リージョン | **Singapore**(日本から最短。Renderのリージョンは Oregon/Ohio/Virginia/Frankfurt/Singapore のみ) | シグナリング遅延の最小化。メディアは直接通信なので影響小 |

ブラウザ対応の実務メモ:
- Chrome/Edge が最有力(WebCodecs・AV1/HEVC HWデコードが揃う)
- Safari は HEVC/WebRTC周りに制約あり、Firefox は decode 性能で不利
- まずは「Chrome/Edge専用」と割り切るのを推奨

---

## 3. 実装ロードマップ(段階ごと)

### Phase 0:プロトコル調査(最重要・1〜3週間)

ブラウザ版を作るには、NVIDIAの**Web版クライアントが使うAPI**を把握する必要があります。
手がかりは3つ:

1. **OpenNOWのソースコード(MITライセンス)**
   - `docs/core-protocol.md`(Qt↔RustコアのJSONプロトコル)
   - Rustコアのアカウントサービス/カタログ/セッション準備まわり
     → NVIDIA ID認証フロー、GFWEB APIのエンドポイント、トークンの扱いが読める
   - MITなので参照・移植は法的に問題なし(クレジット表記は必要)
2. **公式Webクライアント(play.geforcenow.com)のトラフィック解析**
   - DevTools(Network/WS)で、ログイン→ゲーム起動→WebRTC確立までの
     リクエスト列を記録(SDPオファー/アンサーの交換先、ヘッダー、client_id等)
3. **旧Electron版OpenNOWのgit履歴**
   - 引退したElectronアプリはChromium/WebRTCを使っていたはず。
     リポジトリの古いタグ/コミットにWebRTCシグナリング実装が残っている可能性が高い
     → ブラウザ版に最も近い先行実装

成果物:「エンドポイント一覧+シーケンス図(認証→セッション→ICE接続)」のメモ。

### Phase 1:認証+ライブラリ表示(MVP・1〜2週間)

- RenderにNodeサービスをデプロイ
- `POST /api/auth/login`:NVIDIA IDのOAuthフローをプロキシ
  (client_id等のアプリ鍵はPhase 0で判明したものを使う)
- `GET /api/library`:ユーザーのトークンでGFNカタログ/所有ゲームを取得して返す
- フロント:ログインボタン+ゲーム一覧グリッド(カバー画像はGFNのアセットCDNから)
- **セキュリティ原則**:NVIDIAのパスワードはサーバーに保存しない。
  トークンはHttpOnly Cookie or Redis(TTL)に留め、ユーザーごとに隔離。

### Phase 2:セッション確立+映像表示(2〜4週間)

- `POST /api/session/start`:GFNのセッションアサインAPIを呼び、
  メディアサーバー情報(ICEサーバー、エンドポイント)を取得
- WebSocket `/ws/signaling`:ブラウザのSDPオファーを預かり、NVIDIA側と
  アンサーを交換して返す中継を実装
- フロント:`RTCPeerConnection`(video/audio recvonly)→ `ontrack` で
  `<video>` に接続。**ここまでで「映像が映る」=技術的 feasibility の証明**

### Phase 3:入力和品質設定(2〜4週間)

- DataChannel(またはPhase 0で判明した入力チャネル)へ、
  マウス(相対移動+Pointer Lock)、キーボード(scan-code変換、日本語配列注意)、
  ゲームパッド(Gamepad APIポーリング)のパケットを送信
- パケット形式はOpenNOWのRustストリーマー実装(input系)が最良のリファレンス
- 解像度/フレームレート/ビットレート/コーデックの設定UI(GFN APIの対応値にマッピング)
- 統計オーバーレイ(RTT、パケットロス、解像度 — `RTCPeerConnection.getStats()`)

### Phase 4:Render本番デプロイ+堅牢化(1週間)

- `render.yaml` の Blueprint化(下記§4)
- レート制限、エラー時の再接続(セッション再アサイン)、AFK検知
- 無料プランなら keep-alive(15分無通信でスピンダウンするため)
- カスタムドメイン+HTTPS(Renderが自動発行)

### Phase 5(任意):サービス化

- 多ユーザー対応(Postgresでユーザー管理、Redisでセッションプール)
- PWA化・モバイルタッチ操作(仮想ゲームパッド)
- 行列表示(混雑時のqueue)

**トータル目安:個人開発で2〜3ヶ月**(Phase 0の調査が長引くかどうかで大きく変動)。

---

## 4. Renderデプロイ構成(具体)

### 4.1 サービス構成

| サービス | 種類 | プラン | 備考 |
|---|---|---|---|
| frontend | Static Site(またはWeb ServiceでSSR) | Free | 全球CDN。リージョン指定不要 |
| api | Web Service (Node 22) | Free→Starter($7/mo) | WS対応。Freeはスピンダウン注意 |
| redis | Key Value | Free/Starter | トークン・セッション状態(TTL) |
| db(任意) | Postgres | Free | Phase 5で |

### 4.2 render.yaml 例(Blueprint)

```yaml
services:
  - type: web
    name: gfn-web-api
    runtime: node
    plan: free            # 常時稼働が必要なら starter ($7/mo)
    region: singapore     # 日本向けはこれ一択
    buildCommand: npm ci && npm run build
    startCommand: node dist/server.js
    healthCheckPath: /healthz
    envVars:
      - key: NODE_VERSION
        value: 22
      - key: REDIS_URL
        sync: false       # Key Valueインスタンスを接続
      - key: NVIDIA_CLIENT_ID
        sync: false       # Phase 0で判明した値(secret)

  - type: web
    name: gfn-web-frontend
    runtime: static
    buildCommand: npm ci && npm run build
    staticPublishPath: ./dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
```

### 4.3 バックエンド骨格(Fastify + ws)

```js
// server.js — 骨格のみ。実際のエンドポイントはPhase 0の調査結果で埋める
import Fastify from 'fastify'
import { WebSocketServer } from 'ws'
import Redis from 'ioredis'

const app = Fastify()
const redis = new Redis(process.env.REDIS_URL)

// ① NVIDIA ID認証プロキシ(パスワードは保存しない)
app.post('/api/auth/login', async (req, reply) => {
  const res = await fetch('https://<nvidia-id-endpoint>/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ /* code, client_id, ... */ }),
  })
  const tokens = await res.json()
  const sid = crypto.randomUUID()
  await redis.set(`sess:${sid}`, JSON.stringify(tokens), 'EX', 3600)
  reply.setCookie('sid', sid, { httpOnly: true, secure: true, sameSite: 'lax' })
  return { ok: true }
})

// ② GFN APIプロキシ(CORS回避)。ライブラリ・カタログ等
app.all('/api/gfn/*', async (req, reply) => {
  const sid = req.cookies.sid
  const tokens = JSON.parse(await redis.get(`sess:${sid}`) ?? 'null')
  if (!tokens) return reply.code(401).send({ error: 'unauthorized' })
  const upstream = `https://<gfn-web-api-host>${req.url.replace('/api/gfn', '')}`
  const res = await fetch(upstream, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  reply.header('content-type', res.headers.get('content-type'))
  return res.json()
})

// ③ WebRTCシグナリング中継(ブラウザ ⇄ NVIDIAメディアサーバー)
const wss = new WebSocketServer({ noServer: true })
app.server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/signaling') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', async (data) => {
      const msg = JSON.parse(data) // { type: 'offer'|'answer'|'ice', ... }
      // セッションAPIで得たNVIDIA側エンドポイントへSDP/ICEを転送し、
      // 応答をws.send()でブラウザへ返す(形式はPhase 0で確定)
    })
  })
})

app.get('/healthz', async () => ({ ok: true }))
app.listen({ port: process.env.PORT ?? 10000, host: '0.0.0.0' })
```

### 4.4 フロントのプレイヤー骨格

```js
const pc = new RTCPeerConnection({ iceServers: session.iceServers })
pc.addTransceiver('video', { direction: 'recvonly' })
pc.addTransceiver('audio', { direction: 'recvonly' })
pc.ontrack = (e) => { videoEl.srcObject = e.streams[0] }

const ws = new WebSocket(`${API}/ws/signaling`)
const offer = await pc.createOffer(); await pc.setLocalDescription(offer)
ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }))
ws.onmessage = async (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'answer') await pc.setRemoteDescription(msg)
  if (msg.type === 'ice') await pc.addIceCandidate(msg.candidate)
}

// 入力:DataChannel(または調査で判明したチャネル)へ送信
const input = pc.createDataChannel('input')
canvas.requestPointerLock()
window.addEventListener('mousemove', (e) =>
  input.send(encodeMouseDelta(e.movementX, e.movementY))) // 形式はOpenNOW参照
```

### 4.5 Render特有の注意点

- **Freeプランは15分無通信でスピンダウン**(コールドスタート~50秒)。
  ゲーム起動の直前にAPIが眠っていると体験が悪い → Starter($7/mo)推奨、
  またはフロントから定期ping
- WebSocketはFreeでも利用可(ただしスピンダウンの対象)
- リージョンはSingaporeが日本最寄り。メディアはRenderを経由しないので
  遅延への影響はセッション開始時のみ
- Static SiteはCDN配信なのでリージョン選択不可(=問題なし)
- アウトバウンドHTTP(プロキシ)は全プランで可能。帯域はFair Use範囲内

---

## 5. ルートB:「自前のクラウドゲーミング基盤」を作る場合

OpenNOWではなく **GeForce NOWそのものの代替サービス**(自前GPUでゲームを動かし
ブラウザにストリーム)を目指す場合の構成。

### 5.1 なぜRender単体では不可能か

- **RenderにGPUインスタンスは存在しない**(2026年現在もFeature Request止まり)
- ゲームのリアルタイム描画+NVENCエンコードにはGPUが必須
- → **Render=コントロールプレーン、GPUクラウド=データプレーン**の分離構成にする

### 5.2 ハイブリッド構成

```
[ブラウザ] ⇄ WebRTC ⇄ [GPUノード(RunPod/Vast.ai等)]
     │                      ▲
     └─ HTTPS/WS ─ [Render: Web UI・認証・キュー・課金・シグナリング]
                            │
                     [coturn VPS: TURN(必要時)]
```

| 要素 | 選択肢 |
|---|---|
| GPUノード | RunPod / Vast.ai / Lambda / Hetzner GPU / GCP・OCI |
| ストリーミング基盤 | **Selkies-GStreamer**(WebRTC前提のOSS、ブラウザ配信に最適)または **Sunshine**(コンテナ版)+ クライアントはMoonlight/Web |
| ゲーム配信モデル | GFNと同じ「ユーザーが自分のSteam/Epicライブラリを接続」方式 |
| Render側 | ルートAと同様のWebアプリ+セッションオーケストレーション(RunPod APIでGPU Podを起動/破棄) |

### 5.3 現実的な課題(重要)

1. **法的リスクがルートAより桁違いに高い**:
   - 他人にゲームをストリームする商用サービスはパブリッシャーとの契約が必要
     (GeForce NOW自体が長年契約交渉をしてきた領域)
   - 個人が自分のPC/サーバーで自分用に使う分(Moonlight/Sunshine的な利用)は
     一般的に許容されているが、**公開サービス化は別物**
2. **アンチチート**:カーネルレベルのAC(EAC/BattlEye/Vanguard等)は
   VM/コンテナ環境をブロックするタイトルが多く、対応ゲームが限られる
3. **コスト**:RTX 4090級で$0.35〜0.7/時間程度(Vast/RunPod)。
   ユーザー1人が1時間プレイするごとに実費が発生するビジネスモデル設計が必要
4. **遅延**:日本ユーザー向けには東京リージョンのGPU(RunPod Tokyo等)が必須級

→ 趣味/学習なら「自分専用のSelkies-GStreamerノードをRunPodに立て、
Renderのサイトから接続する」構成が現実的なゴール。

---

## 6. リスクと注意事項(ルートA)

| リスク | 内容 | 対策 |
|---|---|---|
| **NVIDIA ToS違反** | 非公式クライアントはGeForce NOW利用規約に抵触しうる。アカウント停止リスクは不明瞭(OpenNOWは2025年末から公開運用されGoogle Playにもあるが、保証はない) | サブアカウントで検証。公開サイト化する場合は利用規約・免責を明記 |
| **プロトコル変更** | NVIDIAのAPI更新でいつでも壊れる。恒常的メンテが必要 | OpenNOWコミュニティ(Discord/GitHub)をウォッチ |
| **法的助言ではない** | 本資料は技術検討用。リバースエンジニアリングの可否は法域・契約次第 | 商用化前に専門家相談 |
| **認証情報の扱い** | ユーザーのNVIDIAトークンを預かる設計は漏洩時の被害が大きい | サーバーに平文保存しない/短TTL/暗号化、可能ならブラウザ側OAuth完結 |
| **Freeプラン制約** | スピンダウン、インスタンス性能 | Starter($7/mo)へ |
| **ブラウザ互換** | Safari/Firefoxでデコード制約 | Chrome/Edge推奨と明記 |

---

## 7. まとめ(推奨手順)

1. **ルートA(GFNクライアントサイト)を個人プロジェクトとして始める**
   — Renderだけで完結し、GPU費用ゼロ。OpenNOW(MIT)が先行実装・資料になる
2. Phase 0(プロトコル調査:OpenNOWのRustコア+旧Electron版履歴+公式Web版の
   トラフィック解析)に最も時間をかける
3. 「認証プロキシ→ライブラリ表示→映像受信→入力」の順で小さく動かす
4. Renderは Singaporeリージョン + Blueprint(render.yaml)で構成管理
5. 公開サイト化はToSリスクを理解した上で行い、免責表示を入れる
6. 本格的な"代替サービス"(ルートB)を目指すなら、Render=制御面+
   RunPod/Vast=GPU面のハイブリッドへ拡張

### 参考リンク
- OpenNOW: https://github.com/OpenCloudGaming/OpenNOW (MIT)
- OpenNOW docs: https://opennow.zortos.me
- 公式Webクライアント: https://play.geforcenow.com
- Render リージョン: https://render.com/docs/regions
- Render Free制限: https://render.com/docs/free
- Selkies-GStreamer(ルートB用): https://github.com/rift-cybergarden/selkies-gstreamer 系OSS
- Sunshine: https://github.com/LizardByte/Sunshine / Moonlight: https://moonlight-stream.org
