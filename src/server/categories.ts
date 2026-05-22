import type { Context } from 'hono';

const CACHE_KEY = 'emoji_categories_v1';
const CACHE_TTL_SECONDS = 60 * 30; // 30 min

type CachedCategories = {
  categories: string[];        // 既存カテゴリ (重複なし、ソート済)
  fetchedAt: number;           // unix ms
};

/**
 * ikaskey の公開 API /api/emojis から既存カテゴリ一覧を抽出して KV にキャッシュ。
 * 申請者・モデレーターが選ぶドロップダウンの選択肢になる。
 *
 * @param opts.fresh true の場合は KV キャッシュを無視して必ず ikaskey から取り直す。
 *   モデレーター画面などで「ページを開いた時点の最新カテゴリ」を出したいときに使う
 *   (取得に成功すれば KV も更新するため、以降の通常取得も最新になる)。
 */
export async function getEmojiCategories(
  c: Context<{ Bindings: Env }>,
  opts: { fresh?: boolean } = {},
): Promise<CachedCategories> {
  // 1) KV から取り出し (fresh 指定時はキャッシュを使わず取り直す)
  const cached = await c.env.KV.get<CachedCategories>(CACHE_KEY, 'json');
  if (!opts.fresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    return cached;
  }

  // 2) miss / fresh → 公開 API を叩く (ikaskey 無応答でワーカーが固まらないよう timeout)
  const r = await fetch(`https://${c.env.MISSKEY_HOST}/api/emojis`, {
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!r || !r.ok) {
    // 失敗したら古いキャッシュを返す (無ければ空)
    return cached ?? { categories: [], fetchedAt: 0 };
  }
  const data = (await r.json()) as { emojis: { category: string | null }[] };
  const set = new Set<string>();
  for (const e of data.emojis) {
    if (e.category && e.category.trim()) set.add(e.category);
  }
  const fresh: CachedCategories = {
    categories: Array.from(set).sort(),
    fetchedAt: Date.now(),
  };
  await c.env.KV.put(CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return fresh;
}
