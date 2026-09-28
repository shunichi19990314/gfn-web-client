// Railway Infrastructure as Code (IaC)
// 使い方:
//   npm install -D railway        # 型解決・CLI評価用パッケージ
//   npm install -g @railway/cli   # Railway CLI
//   railway login && railway link # プロジェクト/環境に接続
//   railway config plan           # 差分プレビュー
//   railway config apply          # 適用
//
// 注意: 旧形式の railway.json / railway.toml (Config as Code) は非推奨であり、
//       新規サービスでは読み込まれない(既存サービスも2026-12-01で終了)ため使用しない。
//       このファイルを使わず、ダッシュボードからのゼロコンフィグデプロイでも動作する
//       (Railpackがpackage.jsonからNodeアプリを自動検出し、scripts.startを使用)。
import { defineRailway, project, service } from "railway/iac";

export default defineRailway(() => {
  const web = service("gfn-web-mvp", {
    build: "npm ci",
    start: "npm start",
    // ヘルスチェック(Renderのrender.yamlと同一パス)
    healthcheckPath: "/healthz",
    // 日本からの遅延が最小の選択肢(Railwayに東京リージョンは無く、シンガポールが最寄り)
    region: "asia-southeast1-eqsg3a",
  });

  return project("gfn-web-mvp", {
    resources: [web],
  });
});
