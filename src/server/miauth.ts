import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { writeSession, clearSession, readSession, revokeSession, type Session } from './session';

/**
 * ログインを始めたブラウザに MiAuth の session ID を覚えさせる cookie。
 * callback で照合し、他人が発行した session ID のリンクを踏ませてその人のアカウントで
 * ログインさせる攻撃 (ログイン CSRF) を防ぐ。
 */
const MIAUTH_STATE_COOKIE = 'iemf_miauth';

type MiAuthState = { session: string; returnTo: string };

/**
 * ログイン後に戻る先を、同じオリジン内のパスに限って取り出す。
 * 外部 URL を許すと、ログイン後に偽サイトへ飛ばすオープンリダイレクトになるため。
 */
export function safeReturnTo(raw: string | null | undefined, origin: string): string {
  if (!raw) return '/';
  let u: URL;
  try {
    u = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (u.origin !== origin) return '/';
  // 認証まわりのパスに戻るとループや再ログアウトになる
  if (/^\/(login|logout|auth\/)/.test(u.pathname)) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * GET /login
 *   1. session UUID を発行
 *   2. Misskey の /miauth/{session} に redirect
 *   3. 承認後、Misskey が ?session=... を付けて callback URL に redirect で戻してくる
 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  const session = crypto.randomUUID();
  const origin = new URL(c.req.url).origin;
  // 戻り先は ?returnTo= を優先し、無ければログインリンクを押したページ (Referer)
  const returnTo = safeReturnTo(c.req.query('returnTo') ?? c.req.header('referer'), origin);
  const state: MiAuthState = { session, returnTo };
  await setSignedCookie(c, MIAUTH_STATE_COOKIE, JSON.stringify(state), c.env.SESSION_SECRET, {
    path: '/auth/callback',
    httpOnly: true,
    secure: true,
    // Misskey からのリダイレクト (トップレベル GET) で送られるよう Lax
    sameSite: 'Lax',
    maxAge: 60 * 10,
  });
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
 *   3. ログインを始めたページ (なければ /) に redirect
 */
export async function handleCallback(c: Context<{ Bindings: Env }>) {
  const session = c.req.query('session');
  if (!session) return c.text('missing session parameter', 400);
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, MIAUTH_STATE_COOKIE);
  deleteCookie(c, MIAUTH_STATE_COOKIE, { path: '/auth/callback' });
  let state: MiAuthState | null = null;
  try {
    state = typeof raw === 'string' ? (JSON.parse(raw) as MiAuthState) : null;
  } catch {
    state = null;
  }
  if (!state || state.session !== session) {
    return c.text('ログインの有効期限が切れたか、別のブラウザで開始されたログインです。もう一度ログインしてください。', 400);
  }

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
    sid: crypto.randomUUID(),
    token: data.token,
    userId: data.user.id,
    username: data.user.username,
    name: data.user.name,
    issuedAt: Date.now(),
  };
  await writeSession(c, sess);
  return c.redirect(safeReturnTo(state.returnTo, new URL(c.req.url).origin));
}

/**
 * POST /logout
 *   cookie を消すだけ。Misskey 側 token の revoke はユーザの設定 UI から。
 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sess = await readSession(c);
  if (sess) {
    await revokeSession(c, sess).catch((e) => console.error('revoke session failed:', e));
  }
  clearSession(c);
  return c.redirect('/');
}
