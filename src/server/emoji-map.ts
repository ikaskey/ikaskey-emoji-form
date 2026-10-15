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
 * MFM の :emoji_name: 部分の描画に使う。Context / Env どちらからも呼べる。
 *
 * @param opts.fresh true ならキャッシュを使わず取り直す (採用時の重複チェック用)
 * @param opts.strict true なら取得に失敗したとき古いキャッシュ・空 map で代用せず例外にする
 */
export async function getEmojiMap(
  arg: Context<{ Bindings: Env }> | Env,
  opts: { fresh?: boolean; strict?: boolean } = {},
): Promise<EmojiMap> {
  const env: Env = isContext(arg) ? arg.env : arg;
  const cached = await env.KV.get<EmojiMap>(CACHE_KEY, 'json');
  if (!opts.fresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    return cached;
  }
  const r = await fetch(`https://${env.MISSKEY_HOST}/api/emojis`, {
    signal: AbortSignal.timeout(10000),
  }).catch((e) => {
    if (opts.strict) throw new Error(`emoji list fetch failed: ${e}`);
    return null;
  });
  if (!r || !r.ok) {
    if (opts.strict) throw new Error(`emoji list fetch failed: status=${r?.status}`);
    return cached ?? { map: {}, fetchedAt: 0 };
  }
  const data = (await r.json()) as { emojis: { name: string; url: string }[] };
  const map: Record<string, string> = {};
  for (const e of data.emojis) {
    if (e.name && e.url) map[e.name] = e.url;
  }
  const fresh: EmojiMap = { map, fetchedAt: Date.now() };
  await env.KV.put(CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch((e) => console.error('emoji map cache put failed:', e));
  return fresh;
}

/**
 * 指定 name が ikaskey 本体にすでに存在するか。
 * 既定はキャッシュ経由 (申請時の目安)。採用時は fresh + strict で最新の一覧と照合する。
 */
export async function emojiNameExists(
  env: Env,
  name: string,
  opts: { fresh?: boolean; strict?: boolean } = {},
): Promise<boolean> {
  const m = await getEmojiMap(env, opts);
  return Object.prototype.hasOwnProperty.call(m.map, name);
}

/** 絵文字を追加・変更したあとに呼び、次回の参照で最新の一覧を取り直させる。 */
export async function invalidateEmojiMap(env: Env): Promise<void> {
  await env.KV.delete(CACHE_KEY).catch((e) => console.error('emoji map cache delete failed:', e));
}

function isContext(x: unknown): x is Context<{ Bindings: Env }> {
  return typeof x === 'object' && x !== null && 'env' in x && 'req' in x;
}
