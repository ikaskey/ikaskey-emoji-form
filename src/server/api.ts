import { Hono } from 'hono';
import { handleLogin, handleCallback, handleLogout } from './miauth';
import { readSession } from './session';
import { getEmojiCategories } from './categories';
import { getEmojiMap } from './emoji-map';
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

  // --- 絵文字 name → URL マップ (MFM 描画用、KV キャッシュ 30 分) ---
  app.get('/api/emoji-map', async (c) => {
    const data = await getEmojiMap(c);
    return c.json(data);
  });

  // --- 申請 ---
  app.post('/api/submit', handleSubmit);

  // --- 申請者: 自分の申請履歴 ---
  app.get('/api/my/applications', async (c) => {
    const sess = await readSession(c);
    if (!sess) return c.json({ error: 'unauthorized' }, 401);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
    const rs = await c.env.DB.prepare(
      `SELECT id, name, category, category_is_new, aliases, comment, mime_type, file_size,
              status, decided_at, decided_by_username, reject_reason,
              registered_emoji_id, registered_emoji_name, created_at
       FROM applications WHERE applicant_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(sess.userId, limit)
      .all();
    return c.json({ applications: rs.results ?? [] });
  });

  // --- 申請者: 自分の申請画像 (pending 中のみ R2 に残っている) ---
  app.get('/api/my/applications/:id/image', async (c) => {
    const sess = await readSession(c);
    if (!sess) return c.text('unauthorized', 401);
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.text('bad id', 400);
    const row = await c.env.DB.prepare(
      `SELECT applicant_id, r2_key, mime_type FROM applications WHERE id = ?`,
    )
      .bind(id)
      .first<{ applicant_id: string; r2_key: string; mime_type: string }>();
    if (!row) return c.text('not found', 404);
    if (row.applicant_id !== sess.userId) return c.text('forbidden', 403);
    if (!row.r2_key) return c.text('no image', 404);
    const obj = await c.env.R2.get(row.r2_key);
    if (!obj) return c.text('image already deleted', 410);
    return new Response(obj.body, {
      headers: {
        'Content-Type': row.mime_type,
        'Cache-Control': 'private, max-age=60',
      },
    });
  });

  // --- モデレーター ---
  app.route('/', buildAdminApi());

  return app;
}
