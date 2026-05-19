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

export function SubmitForm() {
  const [me, setMe] = useState<Me | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // form state
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [isNewCategory, setIsNewCategory] = useState(false);
  const [aliases, setAliases] = useState('');
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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

  if (loading) {
    return <p className="text-gray-500">読み込み中…</p>;
  }

  if (!me || !me.loggedIn) {
    return (
      <div className="space-y-3">
        <p>申請にはいかすきーアカウントでのログインが必要です。</p>
        <a
          href="/login"
          className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          いかすきーでログイン
        </a>
      </div>
    );
  }

  if (state.kind === 'success') {
    return (
      <div className="space-y-3 rounded border border-green-300 bg-green-50 p-4">
        <p className="font-bold text-green-800">申請を受け付けました (id: {state.applicationId})</p>
        <p className="text-sm text-green-700">
          <code>:{state.name}:</code> の申請がモデレーターに通知されました。採用 / 却下の判断が出るまでお待ちください。
        </p>
        <button
          onClick={() => {
            setName('');
            setCategory('');
            setIsNewCategory(false);
            setAliases('');
            setComment('');
            setFile(null);
            setState({ kind: 'idle' });
          }}
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          続けて別の絵文字を申請する
        </button>
      </div>
    );
  }

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!file) {
      setState({ kind: 'error', errors: [{ field: 'file', message: 'ファイルを選択してください' }] });
      return;
    }
    setState({ kind: 'submitting' });

    const fd = new FormData();
    fd.append('name', name);
    fd.append('category', category);
    fd.append('categoryIsNew', isNewCategory ? '1' : '0');
    fd.append('aliases', aliases);
    fd.append('comment', comment);
    fd.append('file', file);

    try {
      const r = await fetch('/api/submit', { method: 'POST', body: fd });
      const data = (await r.json()) as
        | { ok: true; applicationId: number; name: string }
        | { ok: false; errors?: FieldError[]; error?: string };
      if (data.ok) {
        setState({ kind: 'success', applicationId: data.applicationId, name: data.name });
      } else {
        setState({
          kind: 'error',
          errors: data.errors ?? [],
          general: data.error,
        });
      }
    } catch (e) {
      setState({ kind: 'error', errors: [], general: String(e) });
    }
  };

  const errorFor = (field: string) =>
    state.kind === 'error' ? state.errors.find((e) => e.field === field)?.message : undefined;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-gray-600">
        ログイン中: <code>@{me.username}</code>
        {me.name ? (
          <>
            {' ('}
            <Mfm text={me.name} />
            {')'}
          </>
        ) : null}{' '}
        ・<a href="/logout" className="ml-1 underline">ログアウト</a>
      </p>

      {/* name */}
      <div>
        <label className="block text-sm font-medium" htmlFor="name">
          絵文字名 <span className="text-red-600">*</span>
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: hanko_sumi"
          pattern="[a-zA-Z0-9_]+"
          required
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono"
        />
        <p className="mt-1 text-xs text-gray-500">半角英数字とアンダースコア (_) のみ。チャットでは <code>:{name || 'name'}:</code> で参照されます。</p>
        {errorFor('name') && <p className="mt-1 text-sm text-red-600">{errorFor('name')}</p>}
      </div>

      {/* category */}
      <div>
        <label className="block text-sm font-medium" htmlFor="category">カテゴリ</label>
        {isNewCategory ? (
          <input
            id="category"
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="新しいカテゴリ名 (例: 700 Text / 711 さ行 / 712 し)"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          />
        ) : (
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
          >
            <option value="">(未指定 — モデレーターに任せる)</option>
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
            checked={isNewCategory}
            onChange={(e) => {
              setIsNewCategory(e.target.checked);
              setCategory('');
            }}
            className="mr-2"
          />
          新しいカテゴリ (手入力)
        </label>
        {errorFor('category') && <p className="mt-1 text-sm text-red-600">{errorFor('category')}</p>}
      </div>

      {/* aliases */}
      <div>
        <label className="block text-sm font-medium" htmlFor="aliases">エイリアス (カンマ区切り)</label>
        <input
          id="aliases"
          type="text"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="例: 済, 完了, はんこ"
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
        <p className="mt-1 text-xs text-gray-500">日本語の読みや略称を入れておくと検索しやすくなります。</p>
        {errorFor('aliases') && <p className="mt-1 text-sm text-red-600">{errorFor('aliases')}</p>}
      </div>

      {/* file */}
      <div>
        <label className="block text-sm font-medium" htmlFor="file">
          画像ファイル <span className="text-red-600">*</span>
        </label>
        <input
          id="file"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/apng,image/avif"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
          className="mt-1 w-full"
        />
        <p className="mt-1 text-xs text-gray-500">PNG / JPEG / GIF / WebP / APNG / AVIF、2 MiB まで。</p>
        {previewUrl && (
          <div className="mt-2 inline-block rounded border border-gray-300 bg-white p-2">
            <img src={previewUrl} alt="preview" className="max-h-32" />
          </div>
        )}
        {errorFor('file') && <p className="mt-1 text-sm text-red-600">{errorFor('file')}</p>}
      </div>

      {/* comment */}
      <div>
        <label className="block text-sm font-medium" htmlFor="comment">コメント (任意)</label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="申請の意図や用途、出典 (許可済みかなど) を簡潔に。"
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
      </div>

      {state.kind === 'error' && state.general && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{state.general}</p>
      )}

      <button
        type="submit"
        disabled={state.kind === 'submitting'}
        className="rounded bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-700 disabled:bg-gray-400"
      >
        {state.kind === 'submitting' ? '送信中…' : '申請する'}
      </button>
    </form>
  );
}
