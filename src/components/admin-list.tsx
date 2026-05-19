'use client';

import { useEffect, useState } from 'react';
import { Mfm } from './mfm';

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

const TABS = [
  { key: 'pending', label: '未対応' },
  { key: 'approved', label: '採用済' },
  { key: 'rejected', label: '却下済' },
] as const;

export function AdminList() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [status]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`rounded px-3 py-1.5 text-sm ${
              status === t.key
                ? 'bg-blue-600 text-white'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-500">読み込み中…</p>}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
          {error.includes('ログイン') && (
            <a href="/login" className="ml-2 underline">
              ログイン
            </a>
          )}
        </div>
      )}

      {!loading && !error && apps.length === 0 && (
        <p className="text-gray-500">該当する申請はありません。</p>
      )}

      <ul className="space-y-3">
        {apps.map((a) => (
          <li
            key={a.id}
            className="flex gap-4 rounded border border-gray-200 bg-white p-3"
          >
            <a href={`/admin/${a.id}`} className="flex-shrink-0">
              <img
                src={`/api/admin/applications/${a.id}/image`}
                alt={a.name}
                className="h-16 w-16 rounded border border-gray-300 bg-gray-50 object-contain p-1"
              />
            </a>
            <div className="flex-1 space-y-1">
              <a
                href={`/admin/${a.id}`}
                className="block font-mono text-lg font-bold text-blue-700 hover:underline"
              >
                :{a.name}:
              </a>
              <p className="text-sm text-gray-600">
                <span className="text-gray-500">申請者:</span> @{a.applicant_username}
                {a.applicant_name ? (
                  <>
                    {' ('}
                    <Mfm text={a.applicant_name} />
                    {')'}
                  </>
                ) : null}{' '}
                ・ {new Date(a.created_at).toLocaleString('ja-JP')}
              </p>
              <p className="text-xs text-gray-500">
                カテゴリ: {a.category ?? '(未指定)'}
                {a.category_is_new ? ' [新規]' : ''} ・ alias: {prettyAliases(a.aliases)}
              </p>
              {a.status === 'approved' && a.registered_emoji_name && (
                <p className="text-xs text-green-700">
                  ✅ 採用: :{a.registered_emoji_name}: by @{a.decided_by_username}
                </p>
              )}
              {a.status === 'rejected' && (
                <p className="text-xs text-red-700">
                  ❌ 却下 by @{a.decided_by_username}: {a.reject_reason ?? ''}
                </p>
              )}
            </div>
          </li>
        ))}
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
