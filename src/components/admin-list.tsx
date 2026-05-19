'use client';

import { useEffect, useMemo, useState } from 'react';
import { Mfm } from './mfm';
import { StatusStamp } from './status-stamp';

type Application = {
  id: number;
  applicant_username: string;
  applicant_name: string | null;
  name: string;
  category: string | null;
  category_is_new: number;
  aliases: string;
  comment: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decided_by_username: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  registered_emoji_name: string | null;
  created_at: string;
};

type StatusKey = 'pending' | 'approved' | 'rejected';

const TABS: { key: StatusKey; label: string }[] = [
  { key: 'pending', label: '未対応' },
  { key: 'approved', label: '採用済' },
  { key: 'rejected', label: '却下済' },
];

const BULK_MAX = 20;

type BulkResult = {
  ok: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  results: { id: number; ok: boolean; error?: string; emojiName?: string }[];
};

export function AdminList() {
  const [status, setStatus] = useState<StatusKey>('pending');
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'approve' | 'reject' | 'delete'>(null);
  const [bulkMsg, setBulkMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const reload = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/applications?status=${status}`)
      .then(async (r) => {
        if (r.status === 401) throw new Error('ログインが必要です');
        if (r.status === 403) throw new Error('モデレーター権限が必要です');
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        return r.json() as Promise<{ applications: Application[] }>;
      })
      .then((d) => setApps(d.applications))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    setSelected(new Set());
    setBulkMsg(null);
  }, [status]);

  const allVisibleIds = useMemo(() => apps.map((a) => a.id), [apps]);
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selected.has(id));
  const someSelected = allVisibleIds.some((id) => selected.has(id));

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allVisibleIds.slice(0, BULK_MAX)));
  };

  const runBulk = async (action: 'approve' | 'reject' | 'delete') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (ids.length > BULK_MAX) {
      setBulkMsg({ kind: 'error', text: `一度に処理できるのは ${BULK_MAX} 件までです` });
      return;
    }

    let reason: string | undefined;
    let confirmMsg = '';
    if (action === 'approve') {
      confirmMsg = `選択中 ${ids.length} 件をまとめて採用します。\n\n各 mantaro ドライブ転送 + emoji 登録 + 通知 が順次走ります。よろしいですか?`;
    } else if (action === 'reject') {
      const r = window.prompt(`却下する理由を入力してください (選択中 ${ids.length} 件すべてに同じ理由が設定されます)`, '');
      if (r === null) return; // canceled
      reason = r.trim() || '(理由未記入)';
      confirmMsg = `選択中 ${ids.length} 件を「${reason}」で却下します。よろしいですか?`;
    } else if (action === 'delete') {
      confirmMsg = `選択中 ${ids.length} 件を完全削除します (取り消し不可)。よろしいですか?`;
    }
    if (!window.confirm(confirmMsg)) return;

    setBulkBusy(action);
    setBulkMsg(null);
    try {
      const r = await fetch('/api/admin/applications/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action, reason }),
      });
      const d = (await r.json()) as BulkResult | { error: string };
      if (!r.ok || 'error' in d) {
        const msg = 'error' in d ? d.error : `失敗 (status=${r.status})`;
        setBulkMsg({ kind: 'error', text: `バルク処理失敗: ${msg}` });
      } else {
        const summary = `${d.succeeded} 件成功${d.failed > 0 ? ` / ${d.failed} 件失敗` : ''}`;
        if (d.failed > 0) {
          const failed = d.results.filter((x) => !x.ok);
          setBulkMsg({
            kind: 'error',
            text: `${summary}\n失敗: ${failed.map((x) => `#${x.id} (${x.error ?? '?'})`).join(', ')}`,
          });
        } else {
          setBulkMsg({ kind: 'success', text: summary });
        }
        setSelected(new Set());
        reload();
      }
    } catch (e) {
      setBulkMsg({ kind: 'error', text: `通信エラー: ${e}` });
    } finally {
      setBulkBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Tabs */}
      <div role="tablist" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            onClick={() => setStatus(t.key)}
            data-active={status === t.key}
            className="tab"
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Select-all + bulk actions toolbar (sticky when something selected) */}
      <div
        className={`card flex flex-wrap items-center justify-between gap-3 p-3 transition-all ${
          someSelected
            ? 'sticky top-[60px] z-20 shadow-md border-[var(--color-accent)]'
            : ''
        }`}
      >
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allSelected && someSelected;
            }}
            onChange={toggleAll}
            disabled={apps.length === 0}
            className="accent-[var(--color-accent)] w-4 h-4"
          />
          <span className="text-[var(--color-text-muted)]">
            {selected.size > 0
              ? `${selected.size} / ${apps.length} 件選択中`
              : `全選択 (最大 ${BULK_MAX} 件)`}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          {status === 'pending' && (
            <>
              <button
                onClick={() => runBulk('approve')}
                disabled={!someSelected || bulkBusy !== null}
                className="btn btn-success btn-sm"
              >
                {bulkBusy === 'approve' ? '採用中…' : '✓ 一括採用'}
              </button>
              <button
                onClick={() => runBulk('reject')}
                disabled={!someSelected || bulkBusy !== null}
                className="btn btn-danger btn-sm"
              >
                {bulkBusy === 'reject' ? '却下中…' : '✕ 一括却下'}
              </button>
            </>
          )}
          <button
            onClick={() => runBulk('delete')}
            disabled={!someSelected || bulkBusy !== null}
            className="btn btn-ghost btn-sm"
            title="申請レコードを完全削除 (R2 画像も)"
          >
            {bulkBusy === 'delete' ? '削除中…' : '一括削除'}
          </button>
        </div>
      </div>

      {bulkMsg && (
        <div
          className={
            bulkMsg.kind === 'success'
              ? 'alert alert-success'
              : bulkMsg.kind === 'error'
                ? 'alert alert-error'
                : 'alert alert-info'
          }
        >
          <pre className="whitespace-pre-wrap font-sans">{bulkMsg.text}</pre>
        </div>
      )}

      {loading && (
        <p className="text-[var(--color-text-muted)] text-sm">読み込み中…</p>
      )}
      {error && (
        <div className="alert alert-error">
          {error}
          {error.includes('ログイン') && (
            <a href="/login" className="ml-2 font-semibold underline">
              ログイン
            </a>
          )}
        </div>
      )}

      {!loading && !error && apps.length === 0 && (
        <div className="card p-8 text-center space-y-2">
          <div className="text-4xl opacity-40" aria-hidden="true">📭</div>
          <p className="text-[var(--color-text-muted)] text-sm">
            該当する申請はありません。
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {apps.map((a) => {
          const isSelected = selected.has(a.id);
          return (
            <li
              key={a.id}
              className={`card flex gap-3 sm:gap-4 p-4 transition-all ${
                isSelected
                  ? 'border-[var(--color-accent)] shadow-md bg-[var(--color-accent-soft)]/40'
                  : 'hover:shadow-md hover:border-[var(--color-border-strong)]'
              }`}
            >
              <label
                className="shrink-0 flex items-start pt-1 cursor-pointer select-none"
                title="選択 / 解除"
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleOne(a.id)}
                  className="accent-[var(--color-accent)] w-4 h-4"
                />
              </label>
              <a
                href={`/admin/${a.id}`}
                className="shrink-0 group"
                title={`詳細を開く (#${a.id})`}
              >
                <img
                  src={`/api/admin/applications/${a.id}/image`}
                  alt={a.name}
                  className="h-16 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] object-contain p-1.5 group-hover:border-[var(--color-accent)] transition-colors"
                />
              </a>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <a
                    href={`/admin/${a.id}`}
                    className="font-mono text-lg font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline underline-offset-2 break-all leading-tight"
                  >
                    :{a.name}:
                  </a>
                  <StatusStamp status={a.status} />
                </div>
                <p className="text-sm text-[var(--color-text-muted)]">
                  <span className="text-[var(--color-text-faint)]">申請者:</span>{' '}
                  <span className="font-mono text-[var(--color-text)]">@{a.applicant_username}</span>
                  {a.applicant_name ? (
                    <>
                      {' '}
                      <span className="text-[var(--color-text-faint)]">·</span>{' '}
                      <Mfm text={a.applicant_name} />
                    </>
                  ) : null}{' '}
                  <span className="text-[var(--color-text-faint)]">·</span>{' '}
                  {new Date(a.created_at).toLocaleString('ja-JP')}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  <span className="text-[var(--color-text-faint)]">カテゴリ:</span>{' '}
                  {a.category ?? <span className="italic">未指定</span>}
                  {a.category_is_new ? (
                    <span className="ml-1 text-[10px] rounded bg-[var(--color-pending-bg)] text-[var(--color-pending)] px-1.5 py-0.5">
                      新規
                    </span>
                  ) : null}{' '}
                  <span className="text-[var(--color-text-faint)]">·</span>{' '}
                  <span className="text-[var(--color-text-faint)]">エイリアス:</span>{' '}
                  {prettyAliases(a.aliases)}
                </p>
                {a.status === 'approved' && a.registered_emoji_name && (
                  <p className="text-xs text-[var(--color-approved)]">
                    ✓ 採用 <code className="font-mono">:{a.registered_emoji_name}:</code>
                    {a.decided_by_username && (
                      <span className="text-[var(--color-text-faint)] ml-1">
                        by @{a.decided_by_username}
                      </span>
                    )}
                  </p>
                )}
                {a.status === 'rejected' && (
                  <p className="text-xs text-[var(--color-rejected)]">
                    ✕ 却下
                    {a.decided_by_username && (
                      <span className="text-[var(--color-text-faint)] ml-1">
                        by @{a.decided_by_username}
                      </span>
                    )}
                    {a.reject_reason ? `: ${a.reject_reason}` : ''}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function prettyAliases(raw: string): string {
  try {
    const arr = JSON.parse(raw) as string[];
    return arr.length > 0 ? arr.join(', ') : '(なし)';
  } catch {
    return raw;
  }
}
