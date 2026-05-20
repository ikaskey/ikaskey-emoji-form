import { fsRouter } from 'waku';
import adapter from 'waku/adapters/cloudflare';
import { buildApi } from './server/api';

// Waku Cloudflare adapter 戻り値の構造:
//   {
//     defaultExport: { fetch(req, env) {...}, ...handlers },   ← CF Workers の真の entry
//     INTERNAL_runBuild / INTERNAL_runFetch などの SSG/dev 用 export
//   }
// よって CF Workers のリクエストに対して Hono を先に挿し込みたい場合、defaultExport.fetch を
// override する必要がある (トップレベルの fetch を上書きしても効かない)。
const wakuHandler = adapter(
  fsRouter(import.meta.glob('./pages/**/*.{tsx,ts}')),
  {
    handlers: {} satisfies ExportedHandler<Env>,
  },
) as {
  defaultExport: ExportedHandler<Env>;
  [key: string]: unknown;
};

const api = buildApi();
const originalFetch = wakuHandler.defaultExport.fetch;

// Hono ルーターが先に処理する path
const API_PATH_PATTERNS = [
  /^\/login$/,
  /^\/auth\/callback$/,
  /^\/logout$/,
  /^\/api(\/|$)/,
];

async function combinedFetch(
  req: Request<unknown, IncomingRequestCfProperties>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (API_PATH_PATTERNS.some((p) => p.test(url.pathname))) {
    return api.fetch(req, env, ctx);
  }
  if (!originalFetch) {
    return new Response('Waku defaultExport.fetch missing', { status: 500 });
  }
  return originalFetch.call(wakuHandler.defaultExport, req, env, ctx);
}

export default {
  ...wakuHandler,
  defaultExport: {
    ...wakuHandler.defaultExport,
    fetch: combinedFetch,
  },
};
