'use client';

import { useEffect, useState } from 'react';
import { Mfm } from './mfm';
import { StatusStamp } from './status-stamp';
import { formatDateTime } from '../lib/datetime';
import { runAction } from '../lib/run-action';

type Application = {
  id: number;
  applicant_id: string;
  applicant_username: string;
  applicant_name: string | null;
  name: string;
  category: string | null;
  category_is_new: number;
  aliases: string;
  comment: string | null;
  r2_key: string;
  mime_type: string;
  file_size: number;
  original_filename: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by_username: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  registered_emoji_id: string | null;
  registered_emoji_name: string | null;
  created_at: string;
  source_type?: 'upload' | 'remote_copy';
  source_host?: string | null;
  source_remote_name?: string | null;
  source_emoji_id?: string | null;
  source_remote_url?: string | null;
};

type CategoriesResp = { categories: string[]; fetchedAt: number };

export function AdminDetail({ id }: { id: number }) {
  const [app, setApp] = useState<Application | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // editable
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [categoryIsNew, setCategoryIsNew] = useState(false);
  const [aliasesRaw, setAliasesRaw] = useState('');
  const [comment, setComment] = useState('');

  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject' | 'delete'>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'info' | 'success' | 'error'>('info');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`/api/admin/applications/${id}`).then(async (r) => {
        if (r.status === 401) throw new Error('ログインが必要です');
        if (r.status === 403) throw new Error('モデレーター権限が必要です');
        if (r.status === 404) throw new Error('申請が見つかりません');
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        return r.json() as Promise<{ application: Application }>;
      }),
      fetch('/api/categories').then((r) => r.json() as Promise<CategoriesResp>),
    ])
      .then(([d, cats]) => {
        if (cancelled) return;
        setApp(d.application);
        setCategories(cats.categories);
        setName(d.application.name);
        setCategory(d.application.category ?? '');
        setCategoryIsNew(d.application.category_is_new === 1);
        setAliasesRaw(safeAliases(d.application.aliases).join(', '));
        setComment(d.application.comment ?? '');
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <p className="text-[var(--color-text-muted)] text-sm">読み込み中…</p>;
  if (error) {
    return (
      <div className="alert alert-error">
        {error}
        {error.includes('ログイン') && (
          <a href="/login" className="ml-2 font-semibold underline">
            ログイン
          </a>
        )}
      </div>
    );
  }
  if (!app) return null;

  const decided = app.status !== 'pending';

  const setMsg = (msg: string, kind: 'info' | 'success' | 'error' = 'info') => {
    setActionMsg(msg);
    setActionKind(kind);
  };

  /** 申請レコードを再取得して画面を最新化する (決裁後のステータス反映用)。 */
  const refresh = async () => {
    const re = await fetch(`/api/admin/applications/${id}`);
    if (re.ok) setApp(((await re.json()) as { application: Application }).application);
  };

  /** フォームの編集内容を保存する API を叩き、成功時は最新レコードを返す。 */
  const persistForm = async (): Promise<Application> => {
    const r = await fetch(`/api/admin/applications/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, categoryIsNew, aliasesRaw, comment }),
    });
    const d = (await r.json()) as { application?: Application; error?: string };
    if (!r.ok || !d.application) {
      throw new Error(`保存失敗: ${d.error ?? r.status}`);
    }
    return d.application;
  };

  /** 「編集を保存」ボタン。 */
  const save = () =>
    runAction({
      kind: 'save',
      setBusy,
      onError: (m) => setMsg(`保存に失敗しました: ${m}`, 'error'),
      action: async () => {
        setActionMsg(null);
        setApp(await persistForm());
        setMsg('保存しました', 'success');
      },
    });

  /**
   * 「採用」ボタン。フォーム編集内容を先に保存 (押し忘れ防止) してから
   * `/approve` を呼び、mantaro への転送・登録・申請者通知をトリガーする。
   */
  const approve = async () => {
    if (!confirm(`本当に :${name}: を採用しますか?\n\n(mantaro のドライブに転送 → 登録 → 申請者通知が走ります)`)) return;
    await runAction({
      kind: 'approve',
      setBusy,
      onError: (m) => setMsg(`採用処理中に通信エラーが発生しました: ${m}`, 'error'),
      action: async () => {
        setActionMsg(null);
        // 採用前にフォームの編集内容を必ず保存 (押し忘れ防止)
        setApp(await persistForm());

        const r = await fetch(`/api/admin/applications/${id}/approve`, { method: 'POST' });
        const d = (await r.json()) as { ok?: boolean; emoji?: { name: string; id: string }; error?: string; detail?: string };
        if (!r.ok || !d.ok) {
          setMsg(`採用失敗: ${d.error ?? r.status} ${d.detail ?? ''}`, 'error');
          return;
        }
        setMsg(`採用しました: :${d.emoji?.name}:`, 'success');
        await refresh();
      },
    });
  };

  /** 「却下する」ボタン。理由必須。申請者へダイレクト通知し R2 画像も削除される。 */
  const reject = async () => {
    if (!rejectReason.trim()) {
      setMsg('却下理由を入力してください', 'error');
      return;
    }
    if (!confirm(`本当に :${name}: を却下しますか?`)) return;
    await runAction({
      kind: 'reject',
      setBusy,
      onError: (m) => setMsg(`却下処理中に通信エラーが発生しました: ${m}`, 'error'),
      action: async () => {
        setActionMsg(null);
        const r = await fetch(`/api/admin/applications/${id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: rejectReason }),
        });
        const d = (await r.json()) as { ok?: boolean; error?: string };
        if (!r.ok || !d.ok) {
          setMsg(`却下失敗: ${d.error ?? r.status}`, 'error');
          return;
        }
        setMsg('却下しました', 'success');
        await refresh();
      },
    });
  };

  /** 申請レコードを完全削除する (取り消し不可)。成功時は一覧へ遷移。 */
  const remove = async () => {
    if (!confirm(`申請レコード #${id} を完全に削除します (取り消し不可)。よろしいですか?`)) return;
    await runAction({
      kind: 'delete',
      setBusy,
      onError: (m) => setMsg(`削除処理中に通信エラーが発生しました: ${m}`, 'error'),
      action: async () => {
        setActionMsg(null);
        const r = await fetch(`/api/admin/applications/${id}`, { method: 'DELETE' });
        const d = (await r.json()) as { ok?: boolean; error?: string };
        if (r.ok && d.ok) {
          window.location.href = '/admin';
          return;
        }
        setMsg(`削除失敗: ${d.error ?? r.status}`, 'error');
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* Header card: image + meta + status stamp */}
      <section className="card p-5 sm:p-6">
        <div className="flex gap-5 sm:gap-6 flex-col sm:flex-row">
          <div className="shrink-0 mx-auto sm:mx-0">
            {app.status !== 'rejected' ? (
              <a
                href={`/api/admin/applications/${id}/image`}
                target="_blank"
                rel="noreferrer"
                className="block group relative"
              >
                <img
                  src={`/api/admin/applications/${id}/image`}
                  alt={app.name}
                  referrerPolicy="no-referrer"
                  className="h-40 w-40 sm:h-44 sm:w-44 rounded-lg border-2 border-[var(--color-border-strong)] bg-[var(--color-surface-2)] object-contain p-2 group-hover:border-[var(--color-accent)] transition-colors"
                />
                {app.source_type === 'remote_copy' && (
                  <span
                    title="他鯖からインポート"
                    className="absolute -top-1 -right-1 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-info-bg)] text-[var(--color-info)] border border-[var(--color-info)] text-base"
                  >
                    🌐
                  </span>
                )}
                {app.status === 'approved' && (
                  <span
                    title="ikaskey 本体に登録済"
                    className="absolute -bottom-1 -right-1 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-approved-bg)] text-[var(--color-approved)] border border-[var(--color-approved)] text-base"
                  >
                    ✓
                  </span>
                )}
              </a>
            ) : (
              <div className="flex h-40 w-40 sm:h-44 sm:w-44 flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-2 text-xs text-[var(--color-text-faint)] text-center gap-1">
                <span className="text-3xl opacity-50" aria-hidden="true">🗄</span>
                <span>却下済のため<br />画像は削除されました</span>
              </div>
            )}
            <p className="mt-2 text-xs text-[var(--color-text-faint)] text-center font-mono">
              {app.status === 'approved'
                ? `✓ ikaskey 本体`
                : app.source_type === 'remote_copy'
                  ? `🌐 ${app.source_host}`
                  : `${app.mime_type} · ${fmtSize(app.file_size)}`}
            </p>
          </div>

          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <h2 className="font-mono text-2xl font-bold text-[var(--color-accent)] break-all leading-tight">
                :{app.name}:
              </h2>
              <StatusStamp status={app.status} large />
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-[var(--color-text-faint)]">申請者</dt>
              <dd className="text-[var(--color-text)] min-w-0 break-words">
                <span className="font-mono">@{app.applicant_username}</span>
                {app.applicant_name && (
                  <span className="text-[var(--color-text-muted)]">
                    {' · '}<Mfm text={app.applicant_name} />
                  </span>
                )}
              </dd>
              <dt className="text-[var(--color-text-faint)]">申請日時</dt>
              <dd>{formatDateTime(app.created_at)}</dd>
              {app.source_type === 'remote_copy' ? (
                <>
                  <dt className="text-[var(--color-text-faint)]">取り込み元</dt>
                  <dd className="text-[var(--color-info)] break-all">
                    <code className="font-mono">:{app.source_remote_name}:</code> @ {app.source_host}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-[var(--color-text-faint)]">元ファイル</dt>
                  <dd className="font-mono text-xs text-[var(--color-text-muted)] break-all">{app.original_filename ?? '-'}</dd>
                </>
              )}
              {decided && (
                <>
                  <dt className="text-[var(--color-text-faint)]">決裁</dt>
                  <dd>
                    by <span className="font-mono">@{app.decided_by_username}</span> at{' '}
                    {formatDateTime(app.decided_at)}
                  </dd>
                </>
              )}
            </dl>

            {app.status === 'approved' && app.registered_emoji_name && (
              <div className="alert alert-success">
                ✓ 登録名: <code className="font-mono font-semibold">:{app.registered_emoji_name}:</code>
                <span className="text-xs opacity-70 ml-2">(emojiId: {app.registered_emoji_id})</span>
              </div>
            )}
            {app.status === 'rejected' && app.reject_reason && (
              <div className="alert alert-error">
                ✕ 却下理由: {app.reject_reason}
              </div>
            )}
          </div>
        </div>
      </section>

      {!decided ? (
        <>
          {/* Edit form */}
          <section className="card p-5 sm:p-6 space-y-5">
            <div className="flex items-center gap-2">
              <span className="text-xl" aria-hidden="true">✎</span>
              <h2 className="font-display text-lg text-[var(--color-text)]">
                編集 <span className="text-sm text-[var(--color-text-faint)] font-sans">(採用前に直せます)</span>
              </h2>
            </div>

            <div>
              <label className="field-label">絵文字名</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input font-mono"
              />
            </div>

            <div>
              <label className="field-label">カテゴリ</label>
              {categoryIsNew ? (
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="新カテゴリ名"
                  className="input"
                />
              ) : (
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="select"
                >
                  <option value="">(未指定)</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              <label className="mt-2 inline-flex items-center gap-2 text-sm cursor-pointer select-none text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <input
                  type="checkbox"
                  checked={categoryIsNew}
                  onChange={(e) => {
                    setCategoryIsNew(e.target.checked);
                    setCategory('');
                  }}
                  className="accent-[var(--color-accent)] w-4 h-4"
                />
                新しいカテゴリ (手入力)
              </label>
            </div>

            <div>
              <label className="field-label">エイリアス</label>
              <input
                value={aliasesRaw}
                onChange={(e) => setAliasesRaw(e.target.value)}
                placeholder="カンマ区切り"
                className="input"
              />
            </div>

            <div>
              <label className="field-label">コメント <span className="text-[var(--color-text-faint)] font-normal">(申請者から)</span></label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                className="textarea"
              />
            </div>

            <div className="flex flex-wrap gap-3 pt-1">
              <button
                onClick={save}
                disabled={busy !== null}
                className="btn btn-ghost btn-sm"
              >
                {busy === 'save' ? '保存中…' : '編集を保存'}
              </button>
              <button
                onClick={approve}
                disabled={busy !== null}
                className="btn btn-success"
              >
                {busy === 'approve' ? '採用処理中…' : '✓ 採用 (登録 + 通知)'}
              </button>
            </div>
          </section>

          {/* Reject card */}
          <section className="card border-[var(--color-rejected-border)] p-5 sm:p-6 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xl text-[var(--color-rejected)]" aria-hidden="true">✕</span>
              <h2 className="font-display text-lg text-[var(--color-rejected)]">却下する</h2>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">
              申請者に理由付きで通知されます。R2 上の画像も削除されます。
            </p>
            <div>
              <label className="field-label">却下理由</label>
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="例: 既に登録済みの絵文字と類似"
                className="input"
              />
            </div>
            <button
              onClick={reject}
              disabled={busy !== null}
              className="btn btn-danger btn-sm"
            >
              {busy === 'reject' ? '却下処理中…' : '却下する'}
            </button>
          </section>
        </>
      ) : (
        <section className="card-sunken p-4 text-sm text-[var(--color-text-muted)] text-center">
          すでに決裁済のため編集できません。
        </section>
      )}

      {actionMsg && (
        <div
          className={
            actionKind === 'success'
              ? 'alert alert-success'
              : actionKind === 'error'
                ? 'alert alert-error'
                : 'alert alert-info'
          }
        >
          {actionMsg}
        </div>
      )}

      {/* Footer toolbar */}
      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
        <a
          href="/admin"
          className="text-sm text-[var(--color-link)] hover:text-[var(--color-link-hover)] underline-offset-2 hover:underline"
        >
          ← 一覧に戻る
        </a>
        <button
          onClick={remove}
          disabled={busy !== null}
          className="text-xs text-[var(--color-text-faint)] hover:text-[var(--color-rejected)] underline-offset-2 hover:underline disabled:opacity-40"
        >
          {busy === 'delete' ? '削除中…' : 'この申請レコードを削除'}
        </button>
      </div>
    </div>
  );
}

function safeAliases(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
