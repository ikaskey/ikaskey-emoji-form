import { Hono } from 'hono';
import { handleLogin, handleCallback, handleLogout } from './miauth';
import { readSession } from './session';
import { getEmojiCategories } from './categories';
import { handleSubmit } from './submit';
import { buildAdminApi } from './admin';

/**
 * /api/* と /login, /auth/callback, /logout を扱う Hono アプリ。
 * Waku ハンドラの前に挿す。
 */
export function buildApi() {
  const app = new Hono<{ Bindings: Env }>();

  // --- 認証フロー ---
  app.get('/login', handleLogin);
  app.get('/auth/callback', handleCallback);
  app.post('/logout', handleLogout);
  app.get('/logout', handleLogout);

  // --- ヘルスチェック / セッション参照 ---
  app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

  app.get('/api/me', async (c) => {
    const sess = await readSession(c);
    if (!sess) return c.json({ loggedIn: false }, 401);
    return c.json({
      loggedIn: true,
      userId: sess.userId,
      username: sess.username,
      name: sess.name,
      issuedAt: sess.issuedAt,
    });
  });

  // --- カテゴリ一覧 (KV キャッシュ 30 分) ---
  app.get('/api/categories', async (c) => {
    const data = await getEmojiCategories(c);
    return c.json(data);
  });

  // --- 申請 ---
  app.post('/api/submit', handleSubmit);

  // --- モデレーター ---
  app.route('/', buildAdminApi());

  return app;
}
