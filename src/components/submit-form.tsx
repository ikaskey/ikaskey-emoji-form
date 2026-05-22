'use client';

import { useEffect, useState } from 'react';
import { Mfm } from './mfm';

type Me =
  | { loggedIn: true; userId: string; username: string; name: string | null }
  | { loggedIn: false };

type CategoriesResp = { categories: string[]; fetchedAt: number };
type FieldError = { field: string; message: string };
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; applicationId: number; name: string }
  | { kind: 'error'; errors: FieldError[]; general?: string };

type RemoteEmoji = {
  id: string;
  name: string;
  host: string | null;
  url: string;
  aliases: string[];
  category: string | null;
};
type LookupResult = { exact: RemoteEmoji | null; candidates: RemoteEmoji[] };

type SubmitMode = 'upload' | 'remote';

export function SubmitForm() {
  const [me, setMe] = useState<Me | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<SubmitMode>('upload');

  // shared
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [isNewCategory, setIsNewCategory] = useState(false);
  const [aliases, setAliases] = useState('');
  const [comment, setComment] = useState('');

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // remote
  const [sourceHost, setSourceHost] = useState('');
  const [sourceRemoteName, setSourceRemoteName] = useState('');
  const [lookupState, setLookupState] = useState<
    | { kind: 'idle' }
    | { kind: 'looking' }
    | { kind: 'found'; emoji: RemoteEmoji }
    | { kind: 'notfound'; candidates: RemoteEmoji[] }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then((r) =>
        r.status === 401 ? ({ loggedIn: false } as Me) : (r.json() as Promise<Me>),
      ),
      fetch('/api/categories').then((r) => r.json() as Promise<CategoriesResp>),
    ])
      .then(([m, cats]) => {
        setMe(m);
        setCategories(cats.categories);

        // 開いた時点の最新カテゴリをバックグラウンドで取り直して差し替える。
        // (KV キャッシュは最大 30 分古いため)
        fetch('/api/categories?fresh=1')
          .then((r) => (r.ok ? (r.json() as Promise<CategoriesResp>) : null))
          .then((freshCats) => {
            if (freshCats) setCategories(freshCats.categories);
          })
          .catch(() => {});
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const lookupRemote = async () => {
    const h = sourceHost.trim().toLowerCase();
    const n = sourceRemoteName.trim();
    if (!h || !n) {
      setLookupState({ kind: 'error', message: 'host と name を入力してください' });
      return;
    }
    setLookupState({ kind: 'looking' });
    try {
      const r = await fetch(
        `/api/lookup-remote?host=${encodeURIComponent(h)}&name=${encodeURIComponent(n)}`,
      );
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setLookupState({ kind: 'error', message: d.error ?? `lookup failed (${r.status})` });
        return;
      }
      const d = (await r.json()) as LookupResult;
      if (d.exact) {
        setLookupState({ kind: 'found', emoji: d.exact });
        if (!name) setName(d.exact.name);
      } else {
        setLookupState({ kind: 'notfound', candidates: d.candidates });
      }
    } catch (e) {
      setLookupState({ kind: 'error', message: String(e) });
    }
  };

  if (loading) {
    return <p className="text-[var(--color-text-muted)]">読み込み中…</p>;
  }

  if (!me || !me.loggedIn) {
    return (
      <div className="space-y-4 text-center py-6">
        <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-2xl">
          🔑
        </span>
        <p className="text-[var(--color-text)]">
          申請にはいかすきーアカウントでのログインが必要です。
        </p>
        <a href="/login" className="btn btn-primary btn-lg">
          いかすきーでログイン
        </a>
      </div>
    );
  }

  if (state.kind === 'success') {
    return (
      <div className="space-y-5">
        <div className="alert alert-success">
          <p className="font-display text-base">
            🎉 申請を受け付けました <span className="opacity-60 text-xs">(id: #{state.applicationId})</span>
          </p>
          <p className="mt-1 text-sm">
            <code className="font-mono">:{state.name}:</code> の申請がモデレーターに通知されました。採用 / 却下の判断が出るまでお待ちください。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => {
              setName(''); setCategory(''); setIsNewCategory(false); setAliases('');
              setComment(''); setFile(null);
              setSourceHost(''); setSourceRemoteName(''); setLookupState({ kind: 'idle' });
              setState({ kind: 'idle' });
            }}
            className="btn btn-primary"
          >
            続けて別の絵文字を申請する
          </button>
          <a href="/my" className="btn btn-ghost">
            自分の申請一覧 →
          </a>
        </div>
      </div>
    );
  }

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setState({ kind: 'submitting' });
    try {
      if (mode === 'upload') {
        if (!file) {
          setState({ kind: 'error', errors: [{ field: 'file', message: 'ファイルを選択してください' }] });
          return;
        }
        const fd = new FormData();
        fd.append('name', name);
        fd.append('category', category);
        fd.append('categoryIsNew', isNewCategory ? '1' : '0');
        fd.append('aliases', aliases);
        fd.append('comment', comment);
        fd.append('file', file);
        const r = await fetch('/api/submit', { method: 'POST', body: fd });
        const data = (await r.json()) as
          | { ok: true; applicationId: number; name: string }
          | { ok: false; errors?: FieldError[]; error?: string };
        if (data.ok) setState({ kind: 'success', applicationId: data.applicationId, name: data.name });
        else setState({ kind: 'error', errors: data.errors ?? [], ...(data.error ? { general: data.error } : {}) });
      } else {
        // remote
        if (lookupState.kind !== 'found') {
          setState({
            kind: 'error',
            errors: [{ field: 'remote', message: 'まず取り込み元 emoji を検索して確定してください' }],
          });
          return;
        }
        const emoji = lookupState.emoji;
        const body = {
          name: name || emoji.name,
          category,
          categoryIsNew: isNewCategory,
          aliases,
          comment,
          sourceEmojiId: emoji.id,
          sourceHost: emoji.host ?? sourceHost.trim().toLowerCase(),
          sourceRemoteName: emoji.name,
          sourceRemoteUrl: emoji.url,
        };
        const r = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await r.json()) as
          | { ok: true; applicationId: number; name: string }
          | { ok: false; errors?: FieldError[]; error?: string };
        if (data.ok) setState({ kind: 'success', applicationId: data.applicationId, name: data.name });
        else setState({ kind: 'error', errors: data.errors ?? [], ...(data.error ? { general: data.error } : {}) });
      }
    } catch (e) {
      setState({ kind: 'error', errors: [], general: String(e) });
    }
  };

  const errorFor = (field: string) =>
    state.kind === 'error' ? state.errors.find((e) => e.field === field)?.message : undefined;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* user strip */}
      <div className="flex items-center justify-between gap-3 text-sm rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] px-3 py-2">
        <div className="flex items-center gap-2 text-[var(--color-text)] min-w-0">
          <span aria-hidden="true" className="text-base">👤</span>
          <span className="font-mono text-[var(--color-accent)]">@{me.username}</span>
          {me.name ? (
            <span className="text-[var(--color-text-muted)] truncate">
              · <Mfm text={me.name} />
            </span>
          ) : null}
        </div>
        <a
          href="/logout"
          className="shrink-0 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          ログアウト
        </a>
      </div>

      {/* mode tabs */}
      <div role="tablist" className="flex gap-2">
        <button
          type="button"
          role="tab"
          onClick={() => setMode('upload')}
          data-active={mode === 'upload'}
          className="tab flex-1 sm:flex-none"
        >
          📁 ファイルから新規
        </button>
        <button
          type="button"
          role="tab"
          onClick={() => setMode('remote')}
          data-active={mode === 'remote'}
          className="tab flex-1 sm:flex-none"
        >
          🌐 他鯖から取り込み
        </button>
      </div>

      {mode === 'remote' && (
        <div className="card-sunken p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <div>
              <label className="field-label" htmlFor="srcHost">
                取り込み元 host<span className="required">*</span>
              </label>
              <input
                id="srcHost"
                value={sourceHost}
                onChange={(e) => setSourceHost(e.target.value)}
                placeholder="例: misskey.io"
                className="input font-mono"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="srcName">
                元の絵文字名<span className="required">*</span>
              </label>
              <input
                id="srcName"
                value={sourceRemoteName}
                onChange={(e) => setSourceRemoteName(e.target.value)}
                placeholder="例: happy_egg"
                className="input font-mono"
              />
            </div>
            <button
              type="button"
              onClick={lookupRemote}
              disabled={lookupState.kind === 'looking'}
              className="btn btn-ghost"
            >
              {lookupState.kind === 'looking' ? '検索中…' : '🔍 検索'}
            </button>
          </div>

          <p className="field-help">
            いかすきーが過去に **受信したことがある絵文字のみ**取り込めます。未受信の場合はまず該当 host のノートを一度受信させてから再度検索してください。
          </p>

          {lookupState.kind === 'found' && (
            <div className="rounded-md border border-[var(--color-approved-border)] bg-[var(--color-approved-bg)] p-3 flex items-center gap-3">
              <img
                src={lookupState.emoji.url}
                alt={lookupState.emoji.name}
                referrerPolicy="no-referrer"
                className="h-14 w-14 rounded border border-[var(--color-border-strong)] bg-white object-contain p-1"
              />
              <div className="text-sm flex-1 min-w-0">
                <p className="text-[var(--color-approved)] font-semibold">✓ 見つかりました</p>
                <p className="font-mono break-all">:{lookupState.emoji.name}: @ {lookupState.emoji.host}</p>
                {lookupState.emoji.category && (
                  <p className="text-xs text-[var(--color-text-muted)]">元カテゴリ: {lookupState.emoji.category}</p>
                )}
              </div>
            </div>
          )}
          {lookupState.kind === 'notfound' && (
            <div className="alert alert-error">
              <p>該当 emoji がいかすきーのキャッシュにありません。</p>
              {lookupState.candidates.length > 0 && (
                <p className="mt-1 text-xs">候補: {lookupState.candidates.map((e) => e.name).join(', ')}</p>
              )}
            </div>
          )}
          {lookupState.kind === 'error' && (
            <div className="alert alert-error">{lookupState.message}</div>
          )}
        </div>
      )}

      {/* name */}
      <div>
        <label className="field-label" htmlFor="name">
          絵文字名{mode === 'upload' && <span className="required">*</span>}
          {mode === 'remote' && (
            <span className="text-[var(--color-text-faint)] font-normal ml-1 text-xs">(空欄で元の名前を流用)</span>
          )}
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mode === 'upload' ? '例: hanko_sumi' : '空欄可'}
          pattern="[a-zA-Z0-9_]*"
          required={mode === 'upload'}
          className="input font-mono"
        />
        <p className="field-help">
          半角英数字とアンダースコア (_) のみ。チャットでは{' '}
          <code className="font-mono text-[var(--color-accent)]">:{name || 'name'}:</code>{' '}
          で参照されます。
        </p>
        {errorFor('name') && <p className="field-error">{errorFor('name')}</p>}
      </div>

      {/* category */}
      <div>
        <label className="field-label" htmlFor="category">カテゴリ</label>
        {isNewCategory ? (
          <input
            id="category"
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="新しいカテゴリ名 (例: 700 Text / 711 さ行 / 712 し)"
            className="input"
          />
        ) : (
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="select"
          >
            <option value="">(未指定 — モデレーターに任せる)</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <label className="mt-2 inline-flex items-center text-sm gap-2 cursor-pointer select-none text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={isNewCategory}
            onChange={(e) => { setIsNewCategory(e.target.checked); setCategory(''); }}
            className="accent-[var(--color-accent)] w-4 h-4"
          />
          新しいカテゴリ (手入力)
        </label>
        {errorFor('category') && <p className="field-error">{errorFor('category')}</p>}
      </div>

      {/* aliases */}
      <div>
        <label className="field-label" htmlFor="aliases">エイリアス <span className="text-[var(--color-text-faint)] font-normal">(カンマ区切り)</span></label>
        <input
          id="aliases"
          type="text"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="例: 済, 完了, はんこ"
          className="input"
        />
        <p className="field-help">日本語の読みや略称を入れておくと検索しやすくなります。</p>
        {errorFor('aliases') && <p className="field-error">{errorFor('aliases')}</p>}
      </div>

      {mode === 'upload' && (
        <div>
          <label className="field-label" htmlFor="file">
            画像ファイル<span className="required">*</span>
          </label>
          <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
            <div className="flex-1 min-w-0">
              <input
                id="file"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/apng,image/avif"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                required
                className="block w-full text-sm text-[var(--color-text-muted)]"
              />
              <p className="field-help">PNG / JPEG / GIF / WebP / APNG / AVIF、2 MiB まで。</p>
            </div>
            {previewUrl && (
              <div className="card-sunken p-3 flex items-center justify-center min-w-[88px] min-h-[88px]">
                <img src={previewUrl} alt="preview" className="max-h-20 max-w-[140px] object-contain" />
              </div>
            )}
          </div>
          {errorFor('file') && <p className="field-error">{errorFor('file')}</p>}
        </div>
      )}

      {/* comment */}
      <div>
        <label className="field-label" htmlFor="comment">コメント <span className="text-[var(--color-text-faint)] font-normal">(任意)</span></label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="申請の意図や用途、出典 (許可済みかなど) を簡潔に。"
          className="textarea"
        />
      </div>

      {state.kind === 'error' && state.general && (
        <div className="alert alert-error">{state.general}</div>
      )}
      {errorFor('remote') && <div className="alert alert-error">{errorFor('remote')}</div>}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={state.kind === 'submitting' || (mode === 'remote' && lookupState.kind !== 'found')}
          className="btn btn-primary btn-lg"
        >
          {state.kind === 'submitting' ? '送信中…' : '申請する'}
        </button>
        <span className="text-xs text-[var(--color-text-faint)]">
          送信前に内容をご確認ください
        </span>
      </div>
    </form>
  );
}
