import { describe, it, expect } from 'vitest';
import { buildApi } from './api';

const ORIGIN = 'https://emoji.example';

function makeEnv() {
  const kv = new Map<string, string>();
  return {
    SESSION_SECRET: 'test-secret',
    MISSKEY_HOST: 'misskey.example',
    APP_NAME: 'test',
    APP_PERMISSIONS: 'read:account',
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  } as unknown as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe('CSRF / ログアウト', () => {
  const app = buildApi();

  it('他サイトのフォームからの POST は 403', async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/logout`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('同じオリジンからの POST /logout は通る', async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/logout`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('GET /logout は受け付けない', async () => {
    const res = await app.fetch(new Request(`${ORIGIN}/logout`), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

describe('MiAuth callback', () => {
  const app = buildApi();

  it('ログインを始めたブラウザの cookie が無ければ 400', async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/auth/callback?session=attacker-session`),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('/login で発行した cookie と別の session ID は 400', async () => {
    const env = makeEnv();
    const login = await app.fetch(new Request(`${ORIGIN}/login`), env, ctx);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^iemf_miauth=/);
    const res = await app.fetch(
      new Request(`${ORIGIN}/auth/callback?session=other-session`, { headers: { Cookie: cookie } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
