'use client';

import { useEffect, useState } from 'react';
import { Mfm } from './mfm';

type Me =
  | { loggedIn: true; userId: string; username: string; name: string | null }
  | { loggedIn: false };

type Application = {
  id: number;
  name: string;
  category: string | null;
  category_is_new: number;
  aliases: string;
  comment: string | null;
  mime_type: string;
  file_size: number;
  status: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  decided_by_username: string | null;
  reject_reason: string | null;
  registered_emoji_id: string | null;
  registered_emoji_name: string | null;
  created_at: string;
};

export function MyList() {
  const [me, setMe] = useState<Me | null>(null);
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then((r) =>
        r.status === 401 ? ({ loggedIn: false } as Me) : (r.json() as Promise<Me>),
      ),
      fetch('/api/my/applications').then(async (r) => {
        if (r.status === 401) return { applications: [] };
        return r.json() as Promise<{ applications: Application[] }>;
      }),
    ])
      .then(([m, d]) => {
        setMe(m);
        setApps(d.applications);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">読み込み中…</p>;

  if (!me || !me.loggedIn) {
    return (
      <div className="space-y-3">
        <p>ログインすると過去の申請が表示されます。</p>
        <a
          href="/login"
          className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          いかすきーでログイン
        </a>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="space-y-3 text-gray-500">
        <p>まだ申請はありません。</p>
        <a
          href="/submit"
          className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          絵文字を申請する
        </a>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {apps.map((a) => (
        <li key={a.id} className="flex gap-3 rounded border border-gray-200 bg-white p-3">
          <Thumbnail app={a} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-mono text-lg font-bold break-all">:{a.name}:</p>
              <StatusBadge status={a.status} />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              申請日時: {new Date(a.created_at).toLocaleString('ja-JP')}
              {' ・ '}カテゴリ: {a.category ?? '(未指定)'}
              {a.category_is_new ? ' [新規]' : ''}
            </p>
            <p className="text-xs text-gray-500">エイリアス: {prettyAliases(a.aliases)}</p>
            {a.status === 'approved' && a.registered_emoji_name && (
              <p className="mt-2 text-sm text-green-700">
                ✅ <code>:{a.registered_emoji_name}:</code> として登録されました
                {a.decided_by_username && ` (by @${a.decided_by_username})`}
                {a.decided_at && ` / ${new Date(a.decided_at).toLocaleString('ja-JP')}`}
              </p>
            )}
            {a.status === 'rejected' && (
              <p className="mt-2 text-sm text-red-700">
                ❌ 却下されました
                {a.decided_by_username && ` (by @${a.decided_by_username})`}
                <br />
                <span className="text-gray-700">理由: {a.reject_reason ?? '(未記入)'}</span>
              </p>
            )}
            {a.status === 'pending' && (
              <p className="mt-2 text-sm text-orange-700">⌛ モデレーターの確認待ち</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Thumbnail({ app }: { app: Application }) {
  // pending: R2 から私のスコープで取れる
  if (app.status === 'pending') {
    return (
      <a href={`/api/my/applications/${app.id}/image`} target="_blank" rel="noreferrer" className="flex-shrink-0">
        <img
          src={`/api/my/applications/${app.id}/image`}
          alt={`:${app.name}:`}
          className="h-16 w-16 rounded border border-gray-300 bg-gray-50 object-contain p-1"
        />
      </a>
    );
  }
  // approved: 登録済 emoji を Mfm 経由で描画 (emoji-map から URL 解決)
  if (app.status === 'approved' && app.registered_emoji_name) {
    return (
      <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded border border-green-300 bg-green-50 p-1">
        <span className="text-2xl">
          <Mfm text={`:${app.registered_emoji_name}:`} />
        </span>
      </div>
    );
  }
  // rejected or 画像なし
  return (
    <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 text-[10px] text-gray-400">
      画像なし
    </div>
  );
}

function StatusBadge({ status }: { status: 'pending' | 'approved' | 'rejected' }) {
  const map = {
    pending: ['未対応', 'bg-orange-100 text-orange-800 border-orange-300'],
    approved: ['採用', 'bg-green-100 text-green-800 border-green-300'],
    rejected: ['却下', 'bg-red-100 text-red-800 border-red-300'],
  } as const;
  const [label, cls] = map[status];
  return (
    <span className={`rounded border px-2 py-0.5 text-xs ${cls}`}>{label}</span>
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
