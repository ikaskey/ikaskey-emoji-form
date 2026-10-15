import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'iemfsess';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const REVOKED_PREFIX = 'revoked_session:';

export type Session = {
  /** セッション ID。ログアウト時に KV へ失効登録し、cookie が残っていても使えなくする */
  sid: string;
  token: string;       // Misskey access token (MiAuth check の戻り)
  userId: string;
  username: string;
  name: string | null;
  issuedAt: number;
};

/**
 * 署名付き cookie からセッション情報を取り出す。無効/未ログインなら null。
 */
export async function readSession(
  c: Context<{ Bindings: Env }>,
): Promise<Session | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Session;
    // sid の無い旧形式のセッションは失効できないため受け付けない (再ログインしてもらう)
    if (!parsed.token || !parsed.userId || !parsed.sid) return null;
    if (await c.env.KV.get(REVOKED_PREFIX + parsed.sid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** セッションを失効させる。cookie の有効期限が切れるまで KV に失効の印を残す。 */
export async function revokeSession(c: Context<{ Bindings: Env }>, session: Session): Promise<void> {
  const remaining = Math.ceil((session.issuedAt + SESSION_MAX_AGE_SECONDS * 1000 - Date.now()) / 1000);
  if (remaining <= 0) return;
  // KV の expirationTtl は 60 秒以上が必要
  await c.env.KV.put(REVOKED_PREFIX + session.sid, '1', { expirationTtl: Math.max(60, remaining) });
}

/**
 * セッションを発行 (Set-Cookie ヘッダを書き込む)。
 */
export async function writeSession(
  c: Context<{ Bindings: Env }>,
  session: Session,
): Promise<void> {
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(session), c.env.SESSION_SECRET, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSession(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
