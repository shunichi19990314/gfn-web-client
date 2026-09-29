// サーバー起動(Fastify + 静的ファイル + Cookie)
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { registerRoutes, upstreamErrorHandler } from './routes.js';
import { attachSignalingRelay } from './wsRelay.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({
    logger,
    trustProxy: true, // Render / Railway のリバースプロキシ(X-Forwarded-Proto)を信頼
    bodyLimit: 64 * 1024,
  });
  // HTTPS提供されるPaaS(Render / Railway)では Secure Cookie を有効化
  const onPaas =
    Boolean(process.env.RENDER) || // Render
    Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID); // Railway
  app.decorate('productionCookieSecure', process.env.NODE_ENV === 'production' || onPaas);

  // 空body + Content-Type: application/json を許容する。
  // Fastifyはパーラより前段で FST_ERR_CTP_EMPTY_JSON_BODY を投げるため、
  // onRequestフックで content-length: 0 のJSONリクエストから content-type を外す。
  // フロント側でもbody無しのPOSTにContent-Typeを付けないよう修正済み(多層防御)。
  app.addHook('onRequest', async (request) => {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) return;
    const cl = request.headers['content-length'];
    const chunked = request.headers['transfer-encoding'] !== undefined;
    // body が確実に空(content-length: 0 / 未設定 かつ chunked でない)なら
    // content-type を外して Fastify の空JSONボディ拒否を回避する
    if (!chunked && (cl === '0' || cl === undefined)) {
      delete request.headers['content-type'];
    }
  });

  await app.register(fastifyCookie);
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    setHeaders: (res, path) => {
      // HTML/JS/CSSは no-cache(ETag再検証必須)にして、デプロイ後の
      // 「古いフロントエンドJSがブラウザに残る」問題を防ぐ
      if (/\.(html|js|css)$/i.test(path)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  });

  app.setErrorHandler(upstreamErrorHandler);
  await registerRoutes(app);

  // NVSTシグナリングWSリレー(生HTTPサーバーのupgradeをフック)
  attachSignalingRelay({
    app,
    getSession: (sid) => store.getSession(sid),
    getActiveSession: (sid) => store.getActiveSession(sid),
    log: app.log,
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`gfn-web-mvp listening on http://${HOST}:${PORT} (secureCookie=${app.productionCookieSecure})`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
