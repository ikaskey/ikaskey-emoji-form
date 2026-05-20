import { Hono } from 'hono';
import { ensureModerator, type ModeratorInfo } from './moderator';
import { parseAliases, NAME_PATTERN } from './validate';
import {
  mantaroUploadDriveBlob,
  mantaroEmojiAdd,
  mantaroNotesCreate,
  mantaroEmojiCopy,
  mantaroEmojiUpdate,
} from './mantaro';
import { notifyDiscord } from './discord';
import {
  approvedNote,
  rejectedNote,
  approvedDiscord,
  rejectedDiscord,
} from './messages';
import { emojiNameExists } from './emoji-map';

export type ApplicationRow = {
  id: number;
  applicant_id: string;
  applicant_username: string;
  applicant_name: string | null;
  name: string;
  category: string | null;
  category_is_new: number;
  aliases: string;       // JSON string
  comment: string | null;
  r2_key: string;
  mime_type: string;
  file_size: number;
  original_filename: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_by_username: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  registered_emoji_id: string | null;
  registered_emoji_name: string | null;
  created_at: string;
  source_type: 'upload' | 'remote_copy';
  source_host: string | null;
  source_remote_name: string | null;
  source_emoji_id: string | null;
  source_remote_url: string | null;
};

const BULK_MAX = 20;

export function buildAdminApi() {
  const app = new Hono<{ Bindings: Env }>();

  // ---- 一覧 (デフォルト pending、?status=approved or rejected で切替) ----
  app.get('/api/admin/applications', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;

    const status = c.req.query('status') ?? 'pending';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);

    const rs = await c.env.DB.prepare(
      `SELECT id, applicant_id, applicant_username, applicant_name,
              name, category, category_is_new, aliases, comment,
              r2_key, mime_type, file_size, original_filename,
              status, decided_by, decided_by_username, decided_at, reject_reason,
              registered_emoji_id, registered_emoji_name, created_at,
              source_type, source_host, source_remote_name, source_emoji_id, source_remote_url
       FROM applications WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(status, limit)
      .all<ApplicationRow>();
    return c.json({ applications: rs.results ?? [] });
  });

  // ---- 詳細 ----
  app.get('/api/admin/applications/:id', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ application: row });
  });

  // ---- 画像 (採用済は ikaskey 本体の emoji、pending は R2 / remote preview) ----
  app.get('/api/admin/applications/:id/image', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.text('not found', 404);
    // 採用済: ikaskey 本体の emoji URL に redirect (R2 は削除済)
    if (row.status === 'approved' && row.registered_emoji_name) {
      return c.redirect(
        `https://${c.env.MISSKEY_HOST}/emoji/${encodeURIComponent(row.registered_emoji_name)}.webp`,
        302,
      );
    }
    // remote_copy (pending) はオリジナル URL に redirect (Referer は no-referrer 推奨)
    if (row.source_type === 'remote_copy') {
      if (row.source_remote_url) return c.redirect(row.source_remote_url, 302);
      return c.text('no remote url', 404);
    }
    if (!row.r2_key) return c.text('no image', 404);
    const obj = await c.env.R2.get(row.r2_key);
    if (!obj) return c.text('image missing in R2', 410);
    return new Response(obj.body, {
      headers: {
        'Content-Type': row.mime_type,
        'Cache-Control': 'private, max-age=60',
      },
    });
  });

  // ---- バルク (採用 / 却下 / 削除) ----
  //
  // 注意: /:id より前に登録すること!
  // Hono 4 の SmartRouter は `POST /applications/bulk` を `:id='bulk'` で
  // 拾ってしまい、parseInt('bulk')=NaN で 404 を返す挙動が確認されている。
  app.post('/api/admin/applications/bulk', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;

    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: number[];
      action?: 'approve' | 'reject' | 'delete';
      reason?: string;
    };
    const ids = (body.ids ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return c.json({ error: 'no ids provided' }, 400);
    if (ids.length > BULK_MAX) {
      return c.json({ error: `max ${BULK_MAX} per bulk` }, 400);
    }
    const action = body.action;
    if (!['approve', 'reject', 'delete'].includes(action ?? '')) {
      return c.json({ error: 'invalid action' }, 400);
    }
    const reason = (body.reason ?? '').trim() || '(理由未記入)';
    const origin = new URL(c.req.url).origin;

    const results: { id: number; ok: boolean; error?: string; emojiName?: string }[] = [];

    // 直列実行 (mantaro / D1 への並列ヒットを避け、ログを読みやすくする)
    // バルク内で連続採用した name は本体側 cache 反映前に衝突するので Set で追跡。
    const addedNames = new Set<string>();
    for (const id of ids) {
      try {
        if (action === 'approve') {
          const r = await approveOne(c.env, c.executionCtx, mod, id, origin, addedNames);
          addedNames.add(r.emoji.name);
          results.push({ id, ok: true, emojiName: r.emoji.name });
        } else if (action === 'reject') {
          await rejectOne(c.env, c.executionCtx, mod, id, reason, origin);
          results.push({ id, ok: true });
        } else if (action === 'delete') {
          await deleteOne(c.env, c.executionCtx, id);
          results.push({ id, ok: true });
        }
      } catch (e) {
        results.push({ id, ok: false, error: errDetail(e) });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return c.json({
      ok: okCount === results.length,
      processed: results.length,
      succeeded: okCount,
      failed: results.length - okCount,
      results,
    });
  });

  // ---- 編集 (採用前にモデレーターが name/category/aliases/comment を直す) ----
  app.post('/api/admin/applications/:id', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'pending') {
      return c.json({ error: 'already decided' }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      name: string;
      category: string;
      categoryIsNew: boolean;
      aliasesRaw: string;
      comment: string;
    }>;
    const updates: Record<string, unknown> = {};
    if (typeof body.name === 'string') {
      const n = body.name.trim();
      if (!NAME_PATTERN.test(n)) {
        return c.json({ error: 'invalid name' }, 400);
      }
      // 別 name にリネームしようとしている時のみ衝突チェック
      if (n !== row.name && (await emojiNameExists(c.env, n))) {
        return c.json(
          {
            error: 'name_already_exists',
            detail: `絵文字名 :${n}: はすでにいかすきーに存在します。別の名前にしてください。`,
          },
          409,
        );
      }
      updates.name = n;
    }
    if (typeof body.category === 'string') {
      updates.category = body.category.trim() || null;
    }
    if (typeof body.categoryIsNew === 'boolean') {
      updates.category_is_new = body.categoryIsNew ? 1 : 0;
    }
    if (typeof body.aliasesRaw === 'string') {
      updates.aliases = JSON.stringify(parseAliases(body.aliasesRaw));
    }
    if (typeof body.comment === 'string') {
      updates.comment = body.comment.trim() || null;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return c.json({ error: 'no fields to update' }, 400);
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => updates[k]);
    values.push(id);
    await c.env.DB.prepare(`UPDATE applications SET ${setClause} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await fetchApplication(c.env, id);
    return c.json({ application: updated });
  });

  // ---- 単件: 採用 ----
  app.post('/api/admin/applications/:id/approve', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const origin = new URL(c.req.url).origin;
    try {
      const result = await approveOne(c.env, c.executionCtx, mod, id, origin, new Set());
      return c.json({ ok: true, emoji: result.emoji });
    } catch (e) {
      return c.json({ error: errCode(e), detail: errDetail(e) }, errStatus(e));
    }
  });

  // ---- 単件: 却下 ----
  app.post('/api/admin/applications/:id/reject', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason ?? '').trim() || '(理由未記入)';
    const origin = new URL(c.req.url).origin;
    try {
      await rejectOne(c.env, c.executionCtx, mod, id, reason, origin);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errCode(e), detail: String(e) }, errStatus(e));
    }
  });

  // ---- 単件: 削除 ----
  app.delete('/api/admin/applications/:id', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    try {
      await deleteOne(c.env, c.executionCtx, id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errCode(e), detail: String(e) }, errStatus(e));
    }
  });

  return app;
}

// =====================================================================
// per-application action helpers
// =====================================================================

async function approveOne(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  mod: ModeratorInfo,
  id: number,
  origin: string,
  /** 同バルク内ですでに採用した name 集合 (本体 cache 反映前の重複検知) */
  addedNames: Set<string>,
): Promise<{ emoji: { id: string; name: string } }> {
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  if (row.status !== 'pending') throw new ActionError(`already_${row.status}`, 409);

  // 同名チェック (本体 cache + 同バルク内追加分)
  if (addedNames.has(row.name) || (await emojiNameExists(env, row.name))) {
    throw new ActionError(
      `name_already_exists: 絵文字名 :${row.name}: はすでに存在します。申請の名前を変更してから再採用してください。`,
      409,
    );
  }

  const aliases = JSON.parse(row.aliases || '[]') as string[];
  const adminUrl = `${origin}/admin/${id}`;

  // 通知用 attachment (upload 経路は R2 blob、remote 経路は imageUrl だけ)
  let approveAttachment: { filename: string; blob: Blob } | undefined;
  let approveImageUrl: string | undefined;

  let emoji: { id: string; name: string };

  if (row.source_type === 'remote_copy') {
    // ----- 他鯖から取り込み -----
    if (!row.source_emoji_id) {
      throw new ActionError('missing_source_emoji_id', 500);
    }
    let copied: { id: string };
    try {
      copied = await mantaroEmojiCopy(env, row.source_emoji_id);
    } catch (e) {
      throw new ActionError(`emoji_copy_failed: ${e}`, 502);
    }
    // copy 直後の rename + category/aliases 設定
    try {
      await mantaroEmojiUpdate(env, {
        id: copied.id,
        name: row.name,
        category: row.category,
        aliases,
      });
    } catch (e) {
      throw new ActionError(`emoji_update_after_copy_failed: ${e}`, 502);
    }
    emoji = { id: copied.id, name: row.name };
    approveImageUrl = row.source_remote_url ?? undefined;
  } else {
    // ----- 通常のアップロード経路 -----
    const obj = await env.R2.get(row.r2_key);
    if (!obj) throw new ActionError('image_missing_in_r2', 410);
    const arrBuf = await obj.arrayBuffer();
    const blob = new Blob([arrBuf], { type: row.mime_type });

    let driveFile;
    try {
      driveFile = await mantaroUploadDriveBlob(env, row.original_filename ?? row.name, blob);
    } catch (e) {
      throw new ActionError(`drive_upload_failed: ${e}`, 502);
    }

    try {
      emoji = await mantaroEmojiAdd(env, {
        name: row.name,
        fileId: driveFile.id,
        category: row.category,
        aliases,
      });
    } catch (e) {
      throw new ActionError(`emoji_add_failed: ${e}`, 502);
    }

    approveAttachment = {
      filename: `${emoji.name}${inferExt(row.mime_type)}`,
      blob: new Blob([arrBuf], { type: row.mime_type }),
    };

    // R2 cleanup (背景)
    ctx.waitUntil(env.R2.delete(row.r2_key));
  }

  // D1 更新 (共通)
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE applications SET
       status = 'approved',
       decided_by = ?, decided_by_username = ?, decided_at = ?,
       registered_emoji_id = ?, registered_emoji_name = ?
     WHERE id = ?`,
  )
    .bind(mod.session.userId, mod.session.username, now, emoji.id, emoji.name, id)
    .run();

  // 申請者通知 note (共通)
  ctx.waitUntil(
    mantaroNotesCreate(env, {
      text: approvedNote({
        applicantUsername: row.applicant_username,
        emojiName: emoji.name,
      }),
      visibility: 'home',
      localOnly: true,
    }).catch((e) => console.error('approve notify failed:', e)),
  );

  // Discord 通知 (共通)
  ctx.waitUntil(
    notifyDiscord(env, {
      title: `採用: :${emoji.name}:`,
      description: approvedDiscord({
        applicantUsername: row.applicant_username,
        category: row.category,
        decidedByUsername: mod.session.username,
        adminUrl,
      }),
      url: adminUrl,
      color: 0x22c55e,
      attachment: approveAttachment,
      imageUrl: approveImageUrl,
    }),
  );

  return { emoji };
}

async function rejectOne(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  mod: ModeratorInfo,
  id: number,
  reason: string,
  origin: string,
): Promise<void> {
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  if (row.status !== 'pending') throw new ActionError(`already_${row.status}`, 409);

  // R2 の blob を先に取得 (delete より前)
  let rejectBlob: Blob | null = null;
  if (row.r2_key) {
    const obj = await env.R2.get(row.r2_key);
    if (obj) {
      const arrBuf = await obj.arrayBuffer();
      rejectBlob = new Blob([arrBuf], { type: row.mime_type });
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE applications SET
       status = 'rejected',
       decided_by = ?, decided_by_username = ?, decided_at = ?,
       reject_reason = ?
     WHERE id = ?`,
  )
    .bind(mod.session.userId, mod.session.username, now, reason, id)
    .run();

  const adminUrl = `${origin}/admin/${id}`;
  ctx.waitUntil(
    mantaroNotesCreate(env, {
      text: rejectedNote({
        applicantUsername: row.applicant_username,
        applicationName: row.name,
        reason,
      }),
      visibility: 'specified',
      // ダイレクトノートは可視ユーザーを明示しないと申請者に届かない
      visibleUserIds: [row.applicant_id],
      localOnly: true,
    }).catch((e) => console.error('reject notify failed:', e)),
  );
  ctx.waitUntil(
    notifyDiscord(env, {
      title: `却下: :${row.name}:`,
      description: rejectedDiscord({
        applicantUsername: row.applicant_username,
        reason,
        decidedByUsername: mod.session.username,
        adminUrl,
      }),
      url: adminUrl,
      color: 0xef4444,
      attachment: rejectBlob
        ? { filename: `${row.name}${inferExt(row.mime_type)}`, blob: rejectBlob }
        : undefined,
      imageUrl: !rejectBlob && row.source_type === 'remote_copy' && row.source_remote_url
        ? row.source_remote_url
        : undefined,
    }),
  );
  if (row.r2_key) ctx.waitUntil(env.R2.delete(row.r2_key));
}

async function deleteOne(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, id: number): Promise<void> {
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  if (row.r2_key) {
    ctx.waitUntil(env.R2.delete(row.r2_key));
  }
  await env.DB.prepare(`DELETE FROM applications WHERE id = ?`).bind(id).run();
}

// =====================================================================
// helpers
// =====================================================================

class ActionError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}
function errCode(e: unknown): string {
  return e instanceof ActionError ? e.code : 'internal_error';
}
/** UI に出す用の読みやすい一行 (`ActionError.code` の前半をそのまま、その他は message)。 */
function errDetail(e: unknown): string {
  if (e instanceof ActionError) return e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}
function errStatus(e: unknown): 400 | 404 | 409 | 410 | 502 | 500 {
  if (e instanceof ActionError) {
    const s = e.status;
    if (s === 400 || s === 404 || s === 409 || s === 410 || s === 502) return s;
  }
  return 500;
}

function inferExt(mime: string): string {
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

async function fetchApplication(env: Env, id: number): Promise<ApplicationRow | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await env.DB.prepare(`SELECT * FROM applications WHERE id = ?`)
    .bind(id)
    .first<ApplicationRow>();
  return row ?? null;
}
