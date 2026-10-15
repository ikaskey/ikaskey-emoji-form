import type { Context } from 'hono';
import { writeSession, clearSession, type Session } from './session';

/**
 * GET /login
 *   1. session UUID を発行
 *   2. Misskey の /miauth/{session} に redirect
 *   3. 承認後、Misskey が ?session=... を付けて callback URL に redirect で戻してくる
 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  const session = crypto.randomUUID();
  const origin = new URL(c.req.url).origin;
  const callback = encodeURIComponent(`${origin}/auth/callback?session=${session}`);
  const name = encodeURIComponent(c.env.APP_NAME);
  const permission = encodeURIComponent(c.env.APP_PERMISSIONS);
  const url = `https://${c.env.MISSKEY_HOST}/miauth/${session}?name=${name}&callback=${callback}&permission=${permission}`;
  return c.redirect(url);
}

/**
 * GET /auth/callback?session=...
 *   1. session を取得 → Misskey の /api/miauth/{session}/check を叩く
 *   2. 取得した token + user info を cookie に保存
 *   3. / に redirect
 */
export async function handleCallback(c: Context<{ Bindings: Env }>) {
  const session = c.req.query('session');
  if (!session) return c.text('missing session parameter', 400);

  const r = await fetch(
    `https://${c.env.MISSKEY_HOST}/api/miauth/${encodeURIComponent(session)}/check`,
    { method: 'POST', signal: AbortSignal.timeout(10000) },
  ).catch(() => null);
  if (!r) {
    return c.text('MiAuth check failed (upstream unreachable)', 502);
  }
  if (!r.ok) {
    return c.text(`MiAuth check failed (status=${r.status})`, 502);
  }
  const data = (await r.json()) as {
    ok?: boolean;
    token?: string;
    user?: { id: string; username: string; name: string | null };
  };
  if (!data.ok || !data.token || !data.user) {
    return c.text('MiAuth check returned invalid payload', 502);
  }

  const sess: Session = {
    token: data.token,
    userId: data.user.id,
    username: data.user.username,
    name: data.user.name,
    issuedAt: Date.now(),
  };
  await writeSession(c, sess);
  return c.redirect('/');
}

/**
 * POST /logout
 *   cookie を消すだけ。Misskey 側 token の revoke はユーザの設定 UI から。
 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  clearSession(c);
  return c.redirect('/');
}
