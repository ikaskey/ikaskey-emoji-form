import type { Context } from 'hono';
import { readSession } from './session';
import {
  validateSubmit,
  parseAliases,
  ALLOWED_MIME_TYPES,
  NAME_PATTERN,
} from './validate';
import { notifyDiscord } from './discord';
import { submittedDiscord } from './messages';
import { emojiNameExists } from './emoji-map';

/**
 * POST /api/submit
 *
 * 2種類の申請を受け付ける:
 *
 * (A) アップロード型 (multipart/form-data):
 *   type             "upload" (or 省略)
 *   name             string
 *   category         string (空可)
 *   categoryIsNew    "1" | "0"
 *   aliases          string (カンマ/読点区切り)
 *   comment          string (任意)
 *   file             File
 *
 * (B) リモート取り込み型 (application/json):
 *   type             "remote_copy"
 *   name             string         (採用時に使う最終名、空なら sourceRemoteName を流用)
 *   category         string
 *   categoryIsNew    boolean
 *   aliases          string (カンマ/読点区切り)
 *   comment          string
 *   sourceEmojiId    string   ← /api/lookup-remote が返した exact.id を必須
 *   sourceHost       string
 *   sourceRemoteName string
 *   sourceRemoteUrl  string   ← preview 用、storage はしないが Discord 通知に使用
 */
export async function handleSubmit(c: Context<{ Bindings: Env }>) {
  const sess = await readSession(c);
  if (!sess) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const contentType = c.req.header('content-type') ?? '';
  const isJson = contentType.startsWith('application/json');

  if (isJson) {
    return handleRemoteSubmit(c, sess);
  }
  return handleUploadSubmit(c, sess);
}

async function handleUploadSubmit(
  c: Context<{ Bindings: Env }>,
  sess: { userId: string; username: string; name: string | null },
) {
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

  const errors = validateSubmit({
    name, category, categoryIsNew, aliases, comment, file,
  });
  if (errors.length > 0) {
    return c.json({ ok: false, errors }, 400);
  }

  // 同名チェック (ikaskey 本体にすでに存在する name は弾く)
  if (await emojiNameExists(c.env, name)) {
    return c.json(
      {
        ok: false,
        errors: [
          {
            field: 'name',
            message: `絵文字名 :${name}: はすでにいかすきーに存在します。別の名前にしてください。`,
          },
        ],
      },
      400,
    );
  }

  // R2 に保存 (バイト列を一度だけ読んで再利用)
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

  const insert = await c.env.DB.prepare(
    `INSERT INTO applications (
      applicant_id, applicant_username, applicant_name,
      name, category, category_is_new, aliases, comment,
      r2_key, mime_type, file_size, original_filename,
      source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload')`,
  )
    .bind(
      sess.userId, sess.username, sess.name,
      name, category || null, categoryIsNew ? 1 : 0,
      JSON.stringify(aliases), comment || null,
      r2Key, file.type, file.size, file.name,
    )
    .run();

  const applicationId = insert.meta?.last_row_id;
  const adminUrl = `${new URL(c.req.url).origin}/admin/${applicationId ?? ''}`;

  c.executionCtx.waitUntil(
    notifyDiscord(c.env, {
      title: `絵文字申請: :${name}:`,
      description: submittedDiscord({
        applicantUsername: sess.username,
        applicantName: sess.name,
        category,
        categoryIsNew,
        aliases,
        comment,
        source: 'upload',
        adminUrl,
      }),
      url: adminUrl,
      color: 0x4ea3ff,
      attachment: { filename: `${name}${ext}`, blob: new Blob([buf], { type: file.type }) },
    }),
  );

  return c.json({ ok: true, applicationId, name });
}

async function handleRemoteSubmit(
  c: Context<{ Bindings: Env }>,
  sess: { userId: string; username: string; name: string | null },
) {
  type Body = {
    name?: string;
    category?: string;
    categoryIsNew?: boolean;
    aliases?: string;
    comment?: string;
    sourceEmojiId?: string;
    sourceHost?: string;
    sourceRemoteName?: string;
    sourceRemoteUrl?: string;
  };
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }

  const sourceEmojiId = (body.sourceEmojiId ?? '').trim();
  const sourceHost = (body.sourceHost ?? '').trim().toLowerCase();
  const sourceRemoteName = (body.sourceRemoteName ?? '').trim();
  const sourceRemoteUrl = (body.sourceRemoteUrl ?? '').trim();

  if (!sourceEmojiId || !sourceHost || !sourceRemoteName) {
    return c.json({ ok: false, error: 'source_emoji_id / host / remote_name required' }, 400);
  }
  if (!/^[a-z0-9.-]+$/.test(sourceHost)) {
    return c.json({ ok: false, error: 'invalid host' }, 400);
  }

  const name = ((body.name ?? '').trim() || sourceRemoteName).trim();
  const category = (body.category ?? '').trim();
  const categoryIsNew = !!body.categoryIsNew;
  const aliasesRaw = body.aliases ?? '';
  const comment = (body.comment ?? '').trim();

  // 軽量バリデーション
  const errors: { field: string; message: string }[] = [];
  if (!NAME_PATTERN.test(name)) {
    errors.push({ field: 'name', message: '絵文字名は半角英数字とアンダースコアのみ' });
  }
  if (!category) {
    errors.push({
      field: 'category',
      message: categoryIsNew ? '新カテゴリ名を入力してください' : 'カテゴリを選択してください',
    });
  }
  const aliases = parseAliases(aliasesRaw);
  if (errors.length > 0) {
    return c.json({ ok: false, errors }, 400);
  }

  // 同名チェック (ikaskey 本体にすでに存在する name は弾く)
  if (await emojiNameExists(c.env, name)) {
    return c.json(
      {
        ok: false,
        errors: [
          {
            field: 'name',
            message: `絵文字名 :${name}: はすでにいかすきーに存在します。別の名前にしてください。`,
          },
        ],
      },
      400,
    );
  }

  const insert = await c.env.DB.prepare(
    `INSERT INTO applications (
      applicant_id, applicant_username, applicant_name,
      name, category, category_is_new, aliases, comment,
      r2_key, mime_type, file_size, original_filename,
      source_type, source_host, source_remote_name, source_emoji_id, source_remote_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote_copy', ?, ?, ?, ?)`,
  )
    .bind(
      sess.userId, sess.username, sess.name,
      name, category || null, categoryIsNew ? 1 : 0,
      JSON.stringify(aliases), comment || null,
      '',     // r2_key (not used for remote)
      '',     // mime_type (unknown server-side)
      0,      // file_size
      null,   // original_filename
      sourceHost, sourceRemoteName, sourceEmojiId, sourceRemoteUrl || null,
    )
    .run();

  const applicationId = insert.meta?.last_row_id;
  const adminUrl = `${new URL(c.req.url).origin}/admin/${applicationId ?? ''}`;

  c.executionCtx.waitUntil(
    notifyDiscord(c.env, {
      title: `絵文字申請 (取り込み): :${name}:`,
      description: submittedDiscord({
        applicantUsername: sess.username,
        applicantName: sess.name,
        category,
        categoryIsNew,
        aliases,
        comment,
        source: 'remote_copy',
        sourceHost,
        sourceRemoteName,
        adminUrl,
      }),
      url: adminUrl,
      color: 0x9b59b6,
      imageUrl: sourceRemoteUrl || undefined,
    }),
  );

  return c.json({ ok: true, applicationId, name });
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

export { ALLOWED_MIME_TYPES };
