'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mfm } from './mfm';
import { StatusStamp } from './status-stamp';
import { formatDateTime } from '../lib/datetime';

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
  source_type?: 'upload' | 'remote_copy';
  source_host?: string | null;
  source_remote_name?: string | null;
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

  // タブを素早く切り替えたとき、遅れて返った前のタブの応答で一覧を上書きしないための連番
  const loadSeq = useRef(0);

  const reload = () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/applications?status=${status}`)
      .then(async (r) => {
        if (r.status === 401) throw new Error('ログインが必要です');
        if (r.status === 403) throw new Error('モデレーター権限が必要です');
        if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
        return r.json() as Promise<{ applications: Application[] }>;
      })
      .then((d) => {
        if (seq === loadSeq.current) setApps(d.applications);
      })
      .catch((e) => {
        if (seq === loadSeq.current) setError(String(e));
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  };

  useEffect(() => {
    setApps([]);
    reload();
    setSelected(new Set());
    setBulkMsg(null);
  }, [status]);

  const allVisibleIds = useMemo(() => apps.map((a) => a.id), [apps]);
  const someSelected = allVisibleIds.some((id) => selected.has(id));
  // 一度に選べるのは BULK_MAX 件までなので、その上限まで選んでいれば「全選択」とみなす
  const allSelected =
    allVisibleIds.length > 0 && selected.size >= Math.min(allVisibleIds.length, BULK_MAX);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // 何か選択中なら全解除、未選択なら先頭から BULK_MAX 件を選択
  const toggleAll = () => {
    if (someSelected) setSelected(new Set());
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
      reason = r.trim();
      if (!reason) {
        setBulkMsg({ kind: 'error', text: '却下理由を入力してください' });
        return;
      }
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
      const d = (await r.json().catch(() => null)) as BulkResult | { error: string } | null;
      if (!r.ok || !d || 'error' in d) {
        const msg = d && 'error' in d ? d.error : `失敗 (status=${r.status})`;
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
      }
    } catch (e) {
      setBulkMsg({ kind: 'error', text: `通信エラー: ${e}` });
    } finally {
      // 失敗・通信エラーでも一部は処理済みの可能性があるため、常に選択を外して一覧を取り直す
      setSelected(new Set());
      reload();
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
            aria-selected={status === t.key}
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
            aria-label="全選択 / 全解除"
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
          role={bulkMsg.kind === 'error' ? 'alert' : 'status'}
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
                  aria-label={`:${a.name}: を選択`}
                  className="accent-[var(--color-accent)] w-4 h-4"
                />
              </label>
              <a
                href={`/admin/${a.id}`}
                className="shrink-0 group relative"
                title={`詳細を開く (#${a.id})`}
              >
                <ListThumb app={a} />
                {a.source_type === 'remote_copy' && (
                  <span
                    title="他鯖からインポート"
                    className="absolute -top-1 -right-1 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--color-info-bg)] text-[var(--color-info)] border border-[var(--color-info)] text-xs"
                  >
                    🌐
                  </span>
                )}
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
                  {formatDateTime(a.created_at)}
                </p>
                {a.source_type === 'remote_copy' && (
                  <p className="text-xs text-[var(--color-info)]">
                    🌐 取り込み元: <code className="font-mono">:{a.source_remote_name}:</code> @ {a.source_host}
                  </p>
                )}
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

/**
 * 一覧のサムネイル。却下済みのアップロード申請は R2 の画像が消えているので枠だけ出す。
 * それ以外でも読み込みに失敗したら枠に切り替える。
 */
function ListThumb({ app }: { app: Application }) {
  const [failed, setFailed] = useState(false);
  const imageGone = app.status === 'rejected' && app.source_type !== 'remote_copy';
  if (failed || imageGone) {
    return (
      <div
        className="flex h-16 w-16 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-xs text-[var(--color-text-faint)]"
        title="画像は削除済"
      >
        {app.status === 'rejected' ? '✕' : '—'}
      </div>
    );
  }
  return (
    <img
      src={`/api/admin/applications/${app.id}/image`}
      alt={app.name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-16 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] object-contain p-1.5 group-hover:border-[var(--color-accent)] transition-colors"
    />
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
