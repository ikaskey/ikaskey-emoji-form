import { Hono } from 'hono';
import { ensureModerator, type ModeratorInfo } from './moderator';
import { parseAliases, NAME_PATTERN } from './validate';
import { mantaroUploadDriveBlob, mantaroEmojiAdd, mantaroNotesCreate } from './mantaro';
import { notifyDiscord } from './discord';

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
              registered_emoji_id, registered_emoji_name, created_at
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

  // ---- 画像 (R2 から stream) ----
  app.get('/api/admin/applications/:id/image', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.text('not found', 404);
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
      const result = await approveOne(c.env, c.executionCtx, mod, id, origin);
      return c.json({ ok: true, emoji: result.emoji });
    } catch (e) {
      return c.json({ error: errCode(e), detail: String(e) }, errStatus(e));
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

  // ---- バルク (採用 / 却下 / 削除) ----
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
    for (const id of ids) {
      try {
        if (action === 'approve') {
          const r = await approveOne(c.env, c.executionCtx, mod, id, origin);
          results.push({ id, ok: true, emojiName: r.emoji.name });
        } else if (action === 'reject') {
          await rejectOne(c.env, c.executionCtx, mod, id, reason, origin);
          results.push({ id, ok: true });
        } else if (action === 'delete') {
          await deleteOne(c.env, c.executionCtx, id);
          results.push({ id, ok: true });
        }
      } catch (e) {
        results.push({ id, ok: false, error: String(e) });
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

  return app;
}

// =====================================================================
// per-application action helpers
// =====================================================================

async function approveOne(
  env: Env,
  ctx: ExecutionContext,
  mod: ModeratorInfo,
  id: number,
  origin: string,
): Promise<{ emoji: { id: string; name: string } }> {
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  if (row.status !== 'pending') throw new ActionError(`already_${row.status}`, 409);

  // R2 取得 (バイト列保持で mantaro upload と Discord に共用)
  const obj = await env.R2.get(row.r2_key);
  if (!obj) throw new ActionError('image_missing_in_r2', 410);
  const arrBuf = await obj.arrayBuffer();
  const blob = new Blob([arrBuf], { type: row.mime_type });

  // mantaro ドライブに upload
  let driveFile;
  try {
    driveFile = await mantaroUploadDriveBlob(env, row.original_filename ?? row.name, blob);
  } catch (e) {
    throw new ActionError(`drive_upload_failed: ${e}`, 502);
  }

  // admin/emoji/add
  let emoji;
  try {
    emoji = await mantaroEmojiAdd(env, {
      name: row.name,
      fileId: driveFile.id,
      category: row.category,
      aliases: JSON.parse(row.aliases || '[]') as string[],
    });
  } catch (e) {
    throw new ActionError(`emoji_add_failed: ${e}`, 502);
  }

  // D1 更新
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

  // 通知 + R2 cleanup は非同期
  ctx.waitUntil(
    mantaroNotesCreate(env, {
      text: `@${row.applicant_username} 絵文字 :${emoji.name}: を登録しました。ご申請ありがとうございました!`,
      visibility: 'home',
      localOnly: true,
    }).catch((e) => console.error('approve notify failed:', e)),
  );
  ctx.waitUntil(
    notifyDiscord(env, {
      title: `採用: :${emoji.name}:`,
      description: [
        `申請者: @${row.applicant_username}`,
        `カテゴリ: ${row.category ?? '(未指定)'}`,
        `決裁者: @${mod.session.username}`,
        '',
        `**[→ 申請詳細を見る](${origin}/admin/${id})**`,
      ].join('\n'),
      url: `${origin}/admin/${id}`,
      color: 0x22c55e,
      attachment: {
        filename: `${emoji.name}${inferExt(row.mime_type)}`,
        blob: new Blob([arrBuf], { type: row.mime_type }),
      },
    }),
  );
  ctx.waitUntil(env.R2.delete(row.r2_key));

  return { emoji };
}

async function rejectOne(
  env: Env,
  ctx: ExecutionContext,
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

  ctx.waitUntil(
    mantaroNotesCreate(env, {
      text: `@${row.applicant_username} 申し訳ありませんが、絵文字 :${row.name}: の申請を却下しました。\n理由: ${reason}`,
      visibility: 'specified',
      localOnly: true,
    }).catch((e) => console.error('reject notify failed:', e)),
  );
  ctx.waitUntil(
    notifyDiscord(env, {
      title: `却下: :${row.name}:`,
      description: [
        `申請者: @${row.applicant_username}`,
        `理由: ${reason}`,
        `決裁者: @${mod.session.username}`,
        '',
        `**[→ 申請詳細を見る](${origin}/admin/${id})**`,
      ].join('\n'),
      url: `${origin}/admin/${id}`,
      color: 0xef4444,
      attachment: rejectBlob
        ? { filename: `${row.name}${inferExt(row.mime_type)}`, blob: rejectBlob }
        : undefined,
    }),
  );
  ctx.waitUntil(env.R2.delete(row.r2_key));
}

async function deleteOne(env: Env, ctx: ExecutionContext, id: number): Promise<void> {
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
