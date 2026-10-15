import { Hono } from 'hono';
import { ensureModerator, type ModeratorInfo } from './moderator';
import { parseAliases, NAME_PATTERN, ALLOWED_MIME_TYPES, MAX_FILE_SIZE, imageContentMatches } from './validate';
import {
  mantaroUploadDriveBlob,
  mantaroEmojiAdd,
  mantaroNotesCreate,
  mantaroEmojiCopy,
  mantaroEmojiUpdate,
  mantaroEmojiDelete,
  mantaroFindRemote,
  type RemoteEmoji,
} from './mantaro';
import { notifyDiscord } from './discord';
import { invalidateCategories } from './categories';
import {
  approvedNote,
  rejectedNote,
  approvedDiscord,
  rejectedDiscord,
} from './messages';
import { emojiNameExists, getEmojiMap, invalidateEmojiMap } from './emoji-map';

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

/**
 * 採用・却下の処理中は pending のまま decided_by / decided_at に「処理中」の印を付けて
 * 他の操作 (同時採用・採用と却下の競合・編集・削除) を弾く。
 * 処理が途中で落ちて印が残っても、この時間を過ぎれば奪えるようにする。
 */
const CLAIM_TTL_MS = 5 * 60 * 1000;
const claimStaleBefore = () => new Date(Date.now() - CLAIM_TTL_MS).toISOString();

export function buildAdminApi() {
  const app = new Hono<{ Bindings: Env }>();

  // ---- 一覧 (デフォルト pending、?status=approved or rejected で切替) ----
  app.get('/api/admin/applications', async (c) => {
    const mod = await ensureModerator(c);
    if (mod instanceof Response) return mod;

    const status = c.req.query('status') ?? 'pending';
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);

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
      if (row.source_remote_url && isHttpUrl(row.source_remote_url)) {
        return c.redirect(row.source_remote_url, 302);
      }
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
    const ids = [
      ...new Set(
        (body.ids ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
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
    const names = createNameRegistry(c.env);
    for (const id of ids) {
      try {
        if (action === 'approve') {
          const r = await approveOne(c.env, c.executionCtx, mod, id, origin, names);
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
      const cat = body.category.trim();
      if (!cat) return c.json({ error: 'category_required', detail: 'カテゴリを選択してください' }, 400);
      updates.category = cat;
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
    values.push(id, claimStaleBefore());
    // 採用・却下の処理中 (印付き) は編集させない
    const res = await c.env.DB.prepare(
      `UPDATE applications SET ${setClause}
       WHERE id = ? AND status = 'pending' AND (decided_at IS NULL OR decided_at < ?)`,
    )
      .bind(...values)
      .run();
    if (res.meta.changes !== 1) {
      return c.json({ error: 'in_progress', detail: '他のモデレーターがこの申請を処理中です' }, 409);
    }

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
      const result = await approveOne(c.env, c.executionCtx, mod, id, origin, createNameRegistry(c.env));
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
  names: NameRegistry,
): Promise<{ emoji: { id: string; name: string } }> {
  const { row, token } = await claimApplication(env, id, mod);

  const aliases = JSON.parse(row.aliases || '[]') as string[];
  const adminUrl = `${origin}/admin/${id}`;

  // 通知用 attachment (upload 経路は R2 blob、remote 経路は imageUrl だけ)
  let approveAttachment: { filename: string; blob: Blob } | undefined;
  let approveImageUrl: string | undefined;

  let emoji: { id: string; name: string };

  // ここで失敗した場合は Misskey 側に何も残していないので、印を外して再試行できるようにする
  try {
    if (!row.category) {
      throw new ActionError('category_required: カテゴリが未設定です。編集してから採用してください', 409);
    }

    // 同名チェック (本体の最新一覧 + 同リクエスト内で追加した分)
    if (await names.has(row.name)) {
      throw new ActionError(
        `name_already_exists: 絵文字名 :${row.name}: はすでに存在します。申請の名前を変更してから再採用してください。`,
        409,
      );
    }

    if (row.source_type === 'remote_copy') {
      // ----- 他鯖から取り込み -----
      if (!row.source_emoji_id) {
        throw new ActionError('missing_source_emoji_id', 500);
      }
      // admin/emoji/copy は「元の絵文字名のまま」ローカルに追加する (名前指定不可)。
      // 元の名前がローカルで使用中だと、申請名が空いていても DUPLICATE_NAME で失敗するため、
      // その場合は画像を取得して申請名で admin/emoji/add する経路に切り替える。
      // 名前・URL は保存値を信用せず、採用時に id から実体を引き直す
      const src = await resolveRemoteEmoji(env, row);
      const srcNameTaken =
        src.name !== row.name && (await names.has(src.name));

      let copiedId: string | null = null;
      if (!srcNameTaken) {
        try {
          copiedId = (await mantaroEmojiCopy(env, row.source_emoji_id)).id;
        } catch (e) {
          // 名前キャッシュが古く使用中を検知できなかった場合はフォールバックへ
          if (!String(e).includes('DUPLICATE_NAME')) {
            throw new ActionError(`emoji_copy_failed: ${e}`, 502);
          }
        }
      }

      if (copiedId) {
        // copy 直後の rename + category/aliases 設定
        try {
          await mantaroEmojiUpdate(env, {
            id: copiedId,
            name: row.name,
            category: row.category,
            aliases,
          });
        } catch (e) {
          // 元の名前のまま残った絵文字を消して、再試行できる状態に戻す
          await mantaroEmojiDelete(env, copiedId).catch((de) =>
            console.error(`cleanup of copied emoji ${copiedId} failed:`, de),
          );
          throw new ActionError(`emoji_update_after_copy_failed: ${e}`, 502);
        }
        emoji = { id: copiedId, name: row.name };
      } else {
        emoji = await addRemoteEmojiByUrl(env, row, src.url, aliases);
      }
      approveImageUrl = src.url;
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
        throw emojiAddError(e, row.name);
      }

      approveAttachment = {
        filename: `${emoji.name}${inferExt(row.mime_type)}`,
        blob: new Blob([arrBuf], { type: row.mime_type }),
      };
    }
  } catch (e) {
    await releaseClaim(env, id, token);
    throw e;
  }

  // ここから先は Misskey に絵文字が登録済み。失敗しても印は外さない (外すと再採用で二重登録になる)。
  // 印は CLAIM_TTL_MS 経過後に失効する。
  names.add(emoji.name);
  ctx.waitUntil(invalidateEmojiMap(env));
  if (row.category_is_new) ctx.waitUntil(invalidateCategories(env));
  const now = new Date().toISOString();
  let changes = 0;
  try {
    const res = await env.DB.prepare(
      `UPDATE applications SET
         status = 'approved',
         decided_by = ?, decided_by_username = ?, decided_at = ?,
         registered_emoji_id = ?, registered_emoji_name = ?
       WHERE id = ? AND status = 'pending' AND decided_at = ?`,
    )
      .bind(mod.session.userId, mod.session.username, now, emoji.id, emoji.name, id, token)
      .run();
    changes = res.meta.changes;
  } catch (e) {
    throw new ActionError(
      `db_update_failed: 絵文字 :${emoji.name}: (id=${emoji.id}) は登録済みですが、申請の更新に失敗しました: ${e}`,
      500,
    );
  }
  if (changes !== 1) {
    throw new ActionError(
      `claim_lost: 絵文字 :${emoji.name}: (id=${emoji.id}) は登録済みですが、処理中に申請が変更されました`,
      409,
    );
  }

  // R2 cleanup は D1 更新の成功後 (先に消すと D1 失敗時に再試行できなくなる)
  if (row.source_type !== 'remote_copy' && row.r2_key) ctx.waitUntil(env.R2.delete(row.r2_key));

  // 申請者通知 note (共通)
  ctx.waitUntil(
    mantaroNotesCreate(env, {
      text: approvedNote({
        applicantUsername: row.applicant_username,
        emojiName: emoji.name,
      }),
      visibility: 'home',
      localOnly: true,
    }).catch((e) => reportNotifyFailure(env, '採用', emoji.name, row.applicant_username, adminUrl, e)),
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
  const { row, token } = await claimApplication(env, id, mod);

  let rejectBlob: Blob | null = null;
  try {
    // R2 の blob を先に取得 (delete より前)
    if (row.r2_key) {
      const obj = await env.R2.get(row.r2_key);
      if (obj) {
        const arrBuf = await obj.arrayBuffer();
        rejectBlob = new Blob([arrBuf], { type: row.mime_type });
      }
    }

    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      `UPDATE applications SET
         status = 'rejected',
         decided_by = ?, decided_by_username = ?, decided_at = ?,
         reject_reason = ?
       WHERE id = ? AND status = 'pending' AND decided_at = ?`,
    )
      .bind(mod.session.userId, mod.session.username, now, reason, id, token)
      .run();
    if (res.meta.changes !== 1) {
      throw new ActionError('claim_lost: 処理中に申請が変更されました', 409);
    }
  } catch (e) {
    await releaseClaim(env, id, token);
    throw e;
  }

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
    }).catch((e) => reportNotifyFailure(env, '却下', row.name, row.applicant_username, adminUrl, e)),
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
      imageUrl:
        !rejectBlob && row.source_type === 'remote_copy' && row.source_remote_url && isHttpUrl(row.source_remote_url)
          ? row.source_remote_url
          : undefined,
    }),
  );
  if (row.r2_key) ctx.waitUntil(env.R2.delete(row.r2_key));
}

async function deleteOne(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, id: number): Promise<void> {
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  // 採用・却下の処理中は削除させない。D1 を先に消し、R2 は成功後に消す
  const res = await env.DB.prepare(
    `DELETE FROM applications
     WHERE id = ? AND (status != 'pending' OR decided_at IS NULL OR decided_at < ?)`,
  )
    .bind(id, claimStaleBefore())
    .run();
  if (res.meta.changes !== 1) {
    throw new ActionError('in_progress: 他のモデレーターがこの申請を処理中です', 409);
  }
  if (row.r2_key) {
    ctx.waitUntil(env.R2.delete(row.r2_key));
  }
}

/**
 * pending の申請に「処理中」の印を付けて処理権を取る。取れなければ 409。
 * 戻り値の token は印の値で、最終更新・解除のときに自分の印であることの確認に使う。
 */
async function claimApplication(
  env: Env,
  id: number,
  mod: ModeratorInfo,
): Promise<{ row: ApplicationRow; token: string }> {
  if (!Number.isFinite(id) || id <= 0) throw new ActionError('not_found', 404);
  const token = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE applications SET decided_by = ?, decided_at = ?
     WHERE id = ? AND status = 'pending' AND (decided_at IS NULL OR decided_at < ?)`,
  )
    .bind(mod.session.userId, token, id, claimStaleBefore())
    .run();
  const row = await fetchApplication(env, id);
  if (!row) throw new ActionError('not_found', 404);
  if (res.meta.changes !== 1) {
    if (row.status !== 'pending') throw new ActionError(`already_${row.status}`, 409);
    throw new ActionError('in_progress: 他のモデレーターがこの申請を処理中です', 409);
  }
  return { row, token };
}

/** 自分の印が付いたままの pending 申請から印を外す (失敗時のロールバック)。 */
async function releaseClaim(env: Env, id: number, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE applications SET decided_by = NULL, decided_at = NULL
     WHERE id = ? AND status = 'pending' AND decided_at = ?`,
  )
    .bind(id, token)
    .run()
    .catch((e) => console.error(`release claim of application ${id} failed:`, e));
}

/**
 * 申請者への通知ノートが投稿できなかったことをモデレーターに知らせる。
 * (ログだけだと誰も気づかず、申請者に結果が届かないままになるため)
 */
async function reportNotifyFailure(
  env: Env,
  label: string,
  emojiName: string,
  applicantUsername: string,
  adminUrl: string,
  e: unknown,
): Promise<void> {
  console.error(`${label} notify failed:`, e);
  await notifyDiscord(env, {
    title: `⚠ ${label}通知の投稿に失敗: :${emojiName}:`,
    description: `申請者 @${applicantUsername} への通知ノートを投稿できませんでした。必要なら手動で連絡してください。\n\n**[→ 申請詳細を見る](${adminUrl})**`,
    url: adminUrl,
    color: 0xf59e0b,
  });
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
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
function errStatus(e: unknown): 400 | 404 | 409 | 410 | 422 | 502 | 500 {
  if (e instanceof ActionError) {
    const s = e.status;
    if (s === 400 || s === 404 || s === 409 || s === 410 || s === 422 || s === 502) return s;
  }
  return 500;
}

/**
 * source_emoji_id が指す ikaskey キャッシュ上のリモート絵文字を引き直す。
 * 名前・画像 URL は申請時の保存値ではなく、ここで得た実体の値を使う。
 */
async function resolveRemoteEmoji(env: Env, row: ApplicationRow): Promise<RemoteEmoji> {
  if (!row.source_host || !row.source_remote_name) {
    throw new ActionError('missing_source_info', 500);
  }
  let found: RemoteEmoji | null;
  try {
    found = (
      await mantaroFindRemote(env, row.source_host, row.source_remote_name, (e) => e.id === row.source_emoji_id)
    ).found;
  } catch (e) {
    throw new ActionError(`remote_emoji_lookup_failed: ${e}`, 502);
  }
  if (!found) {
    throw new ActionError(
      'remote_emoji_not_found: 取り込み元の絵文字が見つからないか、申請内容と一致しません',
      409,
    );
  }
  return found;
}

/**
 * 取り込み申請を copy を使わずに登録する。元画像を取得してドライブに上げ、申請名で add する。
 * (copy と違い元のライセンス等は引き継がれない)
 */
async function addRemoteEmojiByUrl(
  env: Env,
  row: ApplicationRow,
  imageUrl: string,
  aliases: string[],
): Promise<{ id: string; name: string }> {
  let blob: Blob;
  try {
    const r = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_SIZE) throw new Error(`too large (${len} bytes)`);
    blob = await r.blob();
  } catch (e) {
    throw new ActionError(`remote_image_fetch_failed: ${e}`, 502);
  }
  // アップロード経路 (validateSubmit) と同じ形式・サイズ制限を適用
  const mime = (blob.type.split(';')[0] ?? '').trim();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new ActionError(`remote_image_invalid: unsupported type (${mime || 'unknown'})`, 422);
  }
  if (blob.size > MAX_FILE_SIZE) {
    throw new ActionError(`remote_image_invalid: too large (${blob.size} bytes)`, 422);
  }
  if (!imageContentMatches(mime, new Uint8Array(await blob.slice(0, 16).arrayBuffer()))) {
    throw new ActionError(`remote_image_invalid: content does not match ${mime}`, 422);
  }

  let driveFile;
  try {
    driveFile = await mantaroUploadDriveBlob(env, `${row.name}${inferExt(mime)}`, blob);
  } catch (e) {
    throw new ActionError(`drive_upload_failed: ${e}`, 502);
  }
  try {
    return await mantaroEmojiAdd(env, {
      name: row.name,
      fileId: driveFile.id,
      category: row.category,
      aliases,
    });
  } catch (e) {
    throw emojiAddError(e, row.name);
  }
}

/** admin/emoji/add の失敗を ActionError に変換する。名前の重複は 409 で返す。 */
function emojiAddError(e: unknown, name: string): ActionError {
  if (String(e).includes('DUPLICATE_NAME')) {
    return new ActionError(
      `name_already_exists: 絵文字名 :${name}: はすでに存在します。申請の名前を変更してから再採用してください。`,
      409,
    );
  }
  return new ActionError(`emoji_add_failed: ${e}`, 502);
}

type NameRegistry = {
  has(name: string): Promise<boolean>;
  add(name: string): void;
};

/**
 * 採用時の名前重複チェック。本体の最新一覧は 1 リクエストにつき最初の 1 回だけ取得し、
 * 同リクエスト内で採用した名前を足していく (バルク採用で一覧を何度も取り直さないため)。
 * 一覧が取れないときは重複を確認できないので、採用させずに 502 にする。
 */
function createNameRegistry(env: Env): NameRegistry {
  let names: Promise<Set<string>> | null = null;
  const added = new Set<string>();
  return {
    async has(name) {
      if (added.has(name)) return true;
      names ??= getEmojiMap(env, { fresh: true, strict: true })
        .then((m) => new Set(Object.keys(m.map)))
        .catch((e) => {
          names = null;
          throw new ActionError(`emoji_list_unavailable: 絵文字一覧を取得できませんでした: ${e}`, 502);
        });
      return (await names).has(name);
    },
    add(name) {
      added.add(name);
    },
  };
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
