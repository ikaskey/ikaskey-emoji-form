import type { Context } from 'hono';

const CACHE_KEY = 'emoji_map_v1';
const CACHE_TTL_SECONDS = 60 * 30; // 30 min

export type EmojiMap = {
  /** key: emoji name (host なし local), value: 直接アクセス URL */
  map: Record<string, string>;
  fetchedAt: number;
};

/**
 * ikaskey の公開 /api/emojis をキャッシュして {name: url} に変換。
 * MFM の :emoji_name: 部分の描画に使う。
 */
export async function getEmojiMap(c: Context<{ Bindings: Env }>): Promise<EmojiMap> {
  const cached = await c.env.KV.get<EmojiMap>(CACHE_KEY, 'json');
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    return cached;
  }
  const r = await fetch(`https://${c.env.MISSKEY_HOST}/api/emojis`);
  if (!r.ok) return cached ?? { map: {}, fetchedAt: 0 };
  const data = (await r.json()) as { emojis: { name: string; url: string }[] };
  const map: Record<string, string> = {};
  for (const e of data.emojis) {
    if (e.name && e.url) map[e.name] = e.url;
  }
  const fresh: EmojiMap = { map, fetchedAt: Date.now() };
  await c.env.KV.put(CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return fresh;
}
