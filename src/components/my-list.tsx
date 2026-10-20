'use client';

import { useEffect, useState } from 'react';
import { Mfm } from './mfm';
import { StatusStamp, statusLabel } from './status-stamp';
import { formatDateTime } from '../lib/datetime';
import { loginHref } from '../lib/login';

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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then((r) => {
        if (r.status === 401) return { loggedIn: false } as Me;
        if (!r.ok) throw new Error(`ログイン状態を確認できませんでした (status ${r.status})`);
        return r.json() as Promise<Me>;
      }),
      fetch('/api/my/applications').then(async (r) => {
        if (r.status === 401) return { applications: [] };
        if (!r.ok) throw new Error(`申請一覧を取得できませんでした (status ${r.status})`);
        return r.json() as Promise<{ applications: Application[] }>;
      }),
    ])
      .then(([m, d]) => {
        setMe(m);
        setApps(d.applications);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-[var(--color-text-muted)]">読み込み中…</p>;

  if (loadError) {
    return (
      <div className="card p-6 text-center space-y-4" role="alert">
        <p className="text-[var(--color-text)]">{loadError}</p>
        <button type="button" onClick={() => location.reload()} className="btn btn-primary">
          再読み込み
        </button>
      </div>
    );
  }

  if (!me || !me.loggedIn) {
    return (
      <div className="card p-6 text-center space-y-4">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-xl mx-auto">
          🔑
        </span>
        <p className="text-[var(--color-text)]">
          ログインすると過去の申請が表示されます。
        </p>
        <a href={loginHref()} className="btn btn-primary">
          いかすきーでログイン
        </a>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="card p-8 text-center space-y-4">
        <div className="text-5xl opacity-50" aria-hidden="true">📦</div>
        <p className="text-[var(--color-text-muted)]">
          まだ申請はありません。最初の絵文字を申請してみましょう。
        </p>
        <a href="/submit" className="btn btn-primary">
          絵文字を申請する
        </a>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {apps.map((a) => (
        <li
          key={a.id}
          className="card flex gap-4 p-4 transition-all hover:shadow-md hover:border-[var(--color-border-strong)]"
        >
          <Thumbnail app={a} />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <p className="font-mono text-lg font-semibold text-[var(--color-accent)] break-all leading-tight">
                :{a.name}:
              </p>
              <StatusStamp status={a.status} />
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
              <dt className="text-[var(--color-text-faint)]">申請日時</dt>
              <dd>{formatDateTime(a.created_at)}</dd>
              <dt className="text-[var(--color-text-faint)]">カテゴリ</dt>
              <dd>
                {a.category ?? <span className="italic">未指定</span>}
                {a.category_is_new ? (
                  <span className="ml-2 text-[10px] rounded bg-[var(--color-pending-bg)] text-[var(--color-pending)] px-1.5 py-0.5">
                    新規
                  </span>
                ) : null}
              </dd>
              <dt className="text-[var(--color-text-faint)]">エイリアス</dt>
              <dd className="break-words">{prettyAliases(a.aliases)}</dd>
            </dl>

            {a.status === 'pending' && (
              <p className="text-sm text-[var(--color-pending)] font-medium flex items-center gap-1.5">
                <span aria-hidden="true">⌛</span>
                モデレーターの確認待ち
              </p>
            )}
            {a.status === 'approved' && a.registered_emoji_name && (
              <p className="text-sm text-[var(--color-approved)] flex flex-wrap items-center gap-1.5">
                <span aria-hidden="true">✓</span>
                <span>
                  <code className="font-mono font-semibold">:{a.registered_emoji_name}:</code> として登録されました
                </span>
                {(a.decided_by_username || a.decided_at) && (
                  <span className="text-[var(--color-text-faint)] text-xs">
                    {a.decided_by_username && `by @${a.decided_by_username}`}
                    {a.decided_at && ` / ${formatDateTime(a.decided_at)}`}
                  </span>
                )}
              </p>
            )}
            {a.status === 'rejected' && (
              <div className="rounded-md bg-[var(--color-rejected-bg)] border border-[var(--color-rejected-border)] p-2.5 text-sm text-[var(--color-rejected)] space-y-1">
                <p className="flex items-center gap-1.5">
                  <span aria-hidden="true">✕</span>
                  <span>却下されました</span>
                  {a.decided_by_username && (
                    <span className="text-xs opacity-75">by @{a.decided_by_username}</span>
                  )}
                </p>
                <p className="text-xs text-[var(--color-text)]">
                  理由: {a.reject_reason ?? <span className="italic">(未記入)</span>}
                </p>
              </div>
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
      <a
        href={`/api/my/applications/${app.id}/image`}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 group"
        title={`プレビューを開く (#${app.id})`}
      >
        <img
          src={`/api/my/applications/${app.id}/image`}
          alt={`:${app.name}:`}
          className="h-16 w-16 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] object-contain p-1.5 group-hover:border-[var(--color-accent)] transition-colors"
        />
      </a>
    );
  }
  // approved: 登録済 emoji を Mfm 経由で描画
  if (app.status === 'approved' && app.registered_emoji_name) {
    return (
      <div className="shrink-0 flex h-16 w-16 items-center justify-center rounded-md border-2 border-dashed border-[var(--color-approved-border)] bg-[var(--color-approved-bg)] p-1.5">
        <span className="text-2xl leading-none">
          <Mfm text={`:${app.registered_emoji_name}:`} />
        </span>
      </div>
    );
  }
  // rejected or 画像なし
  return (
    <div
      className="shrink-0 flex h-16 w-16 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[10px] text-[var(--color-text-faint)]"
      title="画像は削除済"
    >
      {statusLabel(app.status) === '却下' ? '✕' : '—'}
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
