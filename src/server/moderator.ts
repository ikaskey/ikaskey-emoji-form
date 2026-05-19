import type { Context } from 'hono';
import { readSession, type Session } from './session';

export type ModeratorInfo = {
  session: Session;
  isAdmin: boolean;
  isModerator: boolean;
};

/**
 * 申請者の MiAuth token を使って /api/i を叩き、moderator/admin かを判定。
 * 成功時 ModeratorInfo を返し、未ログイン/権限不足時は Response を返す。
 * 呼び出し側で `if (result instanceof Response) return result;` する。
 */
export async function ensureModerator(
  c: Context<{ Bindings: Env }>,
): Promise<ModeratorInfo | Response> {
  const sess = await readSession(c);
  if (!sess) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const r = await fetch(`https://${c.env.MISSKEY_HOST}/api/i`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ i: sess.token }),
  });
  if (!r.ok) {
    return c.json({ error: 'auth check failed', upstream: r.status }, 502);
  }
  const me = (await r.json()) as {
    isAdmin?: boolean;
    isModerator?: boolean;
  };
  if (!me.isAdmin && !me.isModerator) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return {
    session: sess,
    isAdmin: !!me.isAdmin,
    isModerator: !!me.isModerator,
  };
}
