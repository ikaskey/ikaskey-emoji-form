'use client';

import { useEffect, useState } from 'react';

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

  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject'>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

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

  if (loading) return <p className="text-gray-500">読み込み中…</p>;
  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
        {error}
        {error.includes('ログイン') && (
          <a href="/login" className="ml-2 underline">
            ログイン
          </a>
        )}
      </div>
    );
  }
  if (!app) return null;

  const decided = app.status !== 'pending';

  const save = async () => {
    setBusy('save');
    setActionMsg(null);
    const r = await fetch(`/api/admin/applications/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, categoryIsNew, aliasesRaw, comment }),
    });
    const d = (await r.json()) as { application?: Application; error?: string };
    setBusy(null);
    if (!r.ok || !d.application) {
      setActionMsg(`保存失敗: ${d.error ?? r.status}`);
      return;
    }
    setApp(d.application);
    setActionMsg('保存しました');
  };

  const approve = async () => {
    if (!confirm(`本当に :${name}: を採用しますか? (mantaro のドライブに転送 → 登録 → 申請者通知が走ります)`)) return;
    setBusy('approve');
    setActionMsg(null);
    const r = await fetch(`/api/admin/applications/${id}/approve`, { method: 'POST' });
    const d = (await r.json()) as { ok?: boolean; emoji?: { name: string; id: string }; error?: string; detail?: string };
    setBusy(null);
    if (!r.ok || !d.ok) {
      setActionMsg(`採用失敗: ${d.error ?? r.status} ${d.detail ?? ''}`);
      return;
    }
    setActionMsg(`採用しました: :${d.emoji?.name}:`);
    // 状態を更新
    const re = await fetch(`/api/admin/applications/${id}`);
    if (re.ok) setApp(((await re.json()) as { application: Application }).application);
  };

  const reject = async () => {
    if (!rejectReason.trim()) {
      setActionMsg('却下理由を入力してください');
      return;
    }
    if (!confirm(`本当に :${name}: を却下しますか?`)) return;
    setBusy('reject');
    setActionMsg(null);
    const r = await fetch(`/api/admin/applications/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: rejectReason }),
    });
    const d = (await r.json()) as { ok?: boolean; error?: string };
    setBusy(null);
    if (!r.ok || !d.ok) {
      setActionMsg(`却下失敗: ${d.error ?? r.status}`);
      return;
    }
    setActionMsg('却下しました');
    const re = await fetch(`/api/admin/applications/${id}`);
    if (re.ok) setApp(((await re.json()) as { application: Application }).application);
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-6">
        <div className="flex-shrink-0">
          {/* 採用後は r2_key 削除済なので画像は出ない */}
          {!decided ? (
            <img
              src={`/api/admin/applications/${id}/image`}
              alt={app.name}
              className="h-48 w-48 rounded border border-gray-300 bg-gray-50 object-contain p-2"
            />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded border border-gray-200 bg-gray-50 text-xs text-gray-400">
              (採用/却下済のため画像は削除)
            </div>
          )}
          <p className="mt-1 text-xs text-gray-500">
            {app.mime_type} / {fmtSize(app.file_size)}
          </p>
        </div>
        <div className="flex-1 space-y-1 text-sm">
          <p>
            <strong>申請者:</strong> @{app.applicant_username}
            {app.applicant_name ? ` (${app.applicant_name})` : ''}
          </p>
          <p>
            <strong>申請日時:</strong> {new Date(app.created_at).toLocaleString('ja-JP')}
          </p>
          <p>
            <strong>元のファイル名:</strong> {app.original_filename ?? '-'}
          </p>
          <p>
            <strong>ステータス:</strong>{' '}
            <span
              className={
                app.status === 'pending'
                  ? 'text-orange-600'
                  : app.status === 'approved'
                    ? 'text-green-700'
                    : 'text-red-700'
              }
            >
              {app.status}
            </span>
            {decided && (
              <>
                {' '}
                (by @{app.decided_by_username} at{' '}
                {app.decided_at ? new Date(app.decided_at).toLocaleString('ja-JP') : '?'})
              </>
            )}
          </p>
          {app.status === 'approved' && app.registered_emoji_name && (
            <p className="text-green-700">
              ✅ 登録名: :{app.registered_emoji_name}: (emojiId: {app.registered_emoji_id})
            </p>
          )}
          {app.status === 'rejected' && app.reject_reason && (
            <p className="text-red-700">❌ 理由: {app.reject_reason}</p>
          )}
        </div>
      </div>

      {!decided ? (
        <div className="space-y-4 rounded border border-gray-200 bg-white p-4">
          <h2 className="text-lg font-bold">編集 (採用前に直せます)</h2>

          <div>
            <label className="block text-sm font-medium">絵文字名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium">カテゴリ</label>
            {categoryIsNew ? (
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="新カテゴリ名"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              />
            ) : (
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              >
                <option value="">(未指定)</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <label className="mt-2 inline-flex items-center text-sm">
              <input
                type="checkbox"
                checked={categoryIsNew}
                onChange={(e) => {
                  setCategoryIsNew(e.target.checked);
                  setCategory('');
                }}
                className="mr-2"
              />
              新しいカテゴリ (手入力)
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium">エイリアス</label>
            <input
              value={aliasesRaw}
              onChange={(e) => setAliasesRaw(e.target.value)}
              placeholder="カンマ区切り"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium">コメント (申請者から)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={save}
              disabled={busy !== null}
              className="rounded bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:bg-gray-400"
            >
              {busy === 'save' ? '保存中…' : '編集を保存'}
            </button>
            <button
              onClick={approve}
              disabled={busy !== null}
              className="rounded bg-green-600 px-6 py-2 font-medium text-white hover:bg-green-700 disabled:bg-gray-400"
            >
              {busy === 'approve' ? '採用処理中…' : '採用 (登録 + 通知)'}
            </button>
          </div>

          <div className="border-t border-gray-200 pt-4">
            <label className="block text-sm font-medium">却下理由</label>
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="例: 既に登録済みの絵文字と類似"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            />
            <button
              onClick={reject}
              disabled={busy !== null}
              className="mt-2 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-gray-400"
            >
              {busy === 'reject' ? '却下処理中…' : '却下する'}
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          すでに決裁済のため編集できません。
        </p>
      )}

      {actionMsg && (
        <p className="rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-700">
          {actionMsg}
        </p>
      )}

      <a href="/admin" className="inline-block text-sm text-blue-600 underline">
        ← 一覧に戻る
      </a>
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
