import type { Context } from 'hono';
import { readSession } from './session';
import {
  validateSubmit,
  parseAliases,
  ALLOWED_MIME_TYPES,
} from './validate';
import { notifyDiscord } from './discord';

/**
 * POST /api/submit
 *   multipart/form-data:
 *     name             string
 *     category         string (空可)
 *     categoryIsNew    "1" | "0"
 *     aliases          string (カンマ/読点区切り、後で配列化)
 *     comment          string (任意)
 *     file             File
 *   要ログイン (cookie session)。
 *   申請レコードを D1 に INSERT、画像を R2 に保存、Discord 通知を発射。
 */
export async function handleSubmit(c: Context<{ Bindings: Env }>) {
  // 1) 認証チェック
  const sess = await readSession(c);
  if (!sess) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  // 2) multipart 取り出し
  let body: Record<string, FormDataEntryValue | FormDataEntryValue[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (e) {
    return c.json({ ok: false, error: `invalid form: ${String(e)}` }, 400);
  }

  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  const categoryIsNew = String(body.categoryIsNew ?? '0') === '1';
  const aliasesRaw = String(body.aliases ?? '');
  const comment = String(body.comment ?? '').trim();
  const file = body.file;

  if (!(file instanceof File)) {
    return c.json({ ok: false, errors: [{ field: 'file', message: 'ファイルがありません' }] }, 400);
  }

  const aliases = parseAliases(aliasesRaw);

  // 3) バリデーション
  const errors = validateSubmit({
    name,
    category,
    categoryIsNew,
    aliases,
    comment,
    file,
  });
  if (errors.length > 0) {
    return c.json({ ok: false, errors }, 400);
  }

  // 4) R2 に保存 (バイト列を一度だけ読んで再利用)
  const buf = await file.arrayBuffer();
  const ext = inferExtension(file.type, file.name);
  const r2Key = `pending/${sess.userId}/${Date.now()}-${crypto.randomUUID()}${ext}`;
  await c.env.R2.put(r2Key, buf, {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      applicantId: sess.userId,
      applicantUsername: sess.username,
      originalName: file.name,
    },
  });

  // 5) D1 に INSERT
  const insert = await c.env.DB.prepare(
    `INSERT INTO applications (
      applicant_id, applicant_username, applicant_name,
      name, category, category_is_new, aliases, comment,
      r2_key, mime_type, file_size, original_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sess.userId,
      sess.username,
      sess.name,
      name,
      category || null,
      categoryIsNew ? 1 : 0,
      JSON.stringify(aliases),
      comment || null,
      r2Key,
      file.type,
      file.size,
      file.name,
    )
    .run();

  const applicationId = insert.meta?.last_row_id;

  // 6) Discord 通知 (非同期、失敗しても submit は成功)
  c.executionCtx.waitUntil(
    notifyDiscord(c.env, {
      title: `絵文字申請: :${name}:`,
      description: [
        `申請者: @${sess.username}${sess.name ? ` (${sess.name})` : ''}`,
        `カテゴリ: ${category || '(未指定)'}${categoryIsNew ? ' [新規]' : ''}`,
        `エイリアス: ${aliases.length > 0 ? aliases.join(', ') : '(なし)'}`,
        comment ? `\nコメント: ${comment}` : '',
      ].join('\n'),
      url: `${new URL(c.req.url).origin}/admin/${applicationId ?? ''}`,
      color: 0x4ea3ff,
      attachment: {
        filename: `${name}${ext}`,
        blob: new Blob([buf], { type: file.type }),
      },
    }),
  );

  return c.json({
    ok: true,
    applicationId,
    name,
  });
}

function inferExtension(mime: string, filename: string): string {
  const fromName = filename.match(/\.[a-zA-Z0-9]+$/)?.[0];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/apng': '.apng',
    'image/avif': '.avif',
  };
  return map[mime] ?? '';
}

// MIME 検証は validate.ts と二重で持っているのでここから export して将来検証用に
export { ALLOWED_MIME_TYPES };
