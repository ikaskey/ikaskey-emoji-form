import { Hono } from 'hono';
import { ensureModerator } from './moderator';
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

  // ---- 採用: mantaro ドライブに画像を移送 → admin/emoji/add → 申請者に通知 note ----
  app.post('/api/admin/applications/:id/approve', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'pending') {
      return c.json({ error: `already ${row.status}` }, 409);
    }

    // 1) R2 から画像を取得
    const obj = await c.env.R2.get(row.r2_key);
    if (!obj) return c.json({ error: 'image missing in R2' }, 410);
    const blob = new Blob([await obj.arrayBuffer()], { type: row.mime_type });

    // 2) mantaro ドライブにアップロード
    let driveFile;
    try {
      driveFile = await mantaroUploadDriveBlob(
        c.env,
        row.original_filename ?? `${row.name}`,
        blob,
      );
    } catch (e) {
      return c.json({ error: 'drive upload failed', detail: String(e) }, 502);
    }

    // 3) admin/emoji/add
    let emoji;
    try {
      emoji = await mantaroEmojiAdd(c.env, {
        name: row.name,
        fileId: driveFile.id,
        category: row.category,
        aliases: JSON.parse(row.aliases || '[]') as string[],
      });
    } catch (e) {
      return c.json({ error: 'emoji add failed', detail: String(e) }, 502);
    }

    // 4) D1 更新
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE applications SET
         status = 'approved',
         decided_by = ?, decided_by_username = ?, decided_at = ?,
         registered_emoji_id = ?, registered_emoji_name = ?
       WHERE id = ?`,
    )
      .bind(mod.session.userId, mod.session.username, now, emoji.id, emoji.name, id)
      .run();

    // 5) 申請者に通知 note (mantaro 名義、メンション付き、ローカルオンリー)
    c.executionCtx.waitUntil(
      mantaroNotesCreate(c.env, {
        text: `@${row.applicant_username} 絵文字 :${emoji.name}: を登録しました。ご申請ありがとうございました!`,
        visibility: 'home',
        localOnly: true,
      }).catch((e) => console.error('notify note failed:', e)),
    );

    // 6) Discord 通知
    c.executionCtx.waitUntil(
      notifyDiscord(c.env, {
        title: `採用: :${emoji.name}:`,
        description: `申請者: @${row.applicant_username}\nカテゴリ: ${row.category ?? '(未指定)'}\n決裁者: @${mod.session.username}`,
        color: 0x22c55e,
      }),
    );

    // 7) R2 から画像を削除 (staging クリーンアップ)
    c.executionCtx.waitUntil(c.env.R2.delete(row.r2_key));

    return c.json({ ok: true, emoji });
  });

  // ---- 却下 ----
  app.post('/api/admin/applications/:id/reject', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'pending') {
      return c.json({ error: `already ${row.status}` }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason ?? '').trim() || '(理由未記入)';

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE applications SET
         status = 'rejected',
         decided_by = ?, decided_by_username = ?, decided_at = ?,
         reject_reason = ?
       WHERE id = ?`,
    )
      .bind(mod.session.userId, mod.session.username, now, reason, id)
      .run();

    // 申請者通知
    c.executionCtx.waitUntil(
      mantaroNotesCreate(c.env, {
        text: `@${row.applicant_username} 申し訳ありませんが、絵文字 :${row.name}: の申請を却下しました。\n理由: ${reason}`,
        visibility: 'specified',
        localOnly: true,
      }).catch((e) => console.error('reject notify failed:', e)),
    );

    c.executionCtx.waitUntil(
      notifyDiscord(c.env, {
        title: `却下: :${row.name}:`,
        description: `申請者: @${row.applicant_username}\n理由: ${reason}\n決裁者: @${mod.session.username}`,
        color: 0xef4444,
      }),
    );

    c.executionCtx.waitUntil(c.env.R2.delete(row.r2_key));

    return c.json({ ok: true });
  });

  // ---- 申請レコード削除 (R2 にまだ画像が残っていれば一緒に消す) ----
  app.delete('/api/admin/applications/:id', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;
    const id = parseInt(c.req.param('id'), 10);
    const row = await fetchApplication(c.env, id);
    if (!row) return c.json({ error: 'not found' }, 404);

    // R2 cleanup (pending なら残っている)
    if (row.r2_key) {
      c.executionCtx.waitUntil(c.env.R2.delete(row.r2_key));
    }
    await c.env.DB.prepare(`DELETE FROM applications WHERE id = ?`).bind(id).run();
    return c.json({ ok: true });
  });

  return app;
}

async function fetchApplication(env: Env, id: number): Promise<ApplicationRow | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM applications WHERE id = ?`,
  )
    .bind(id)
    .first<ApplicationRow>();
  return row ?? null;
}
