import { env } from 'cloudflare:workers'; // eslint-disable-line import/no-unresolved

export default async function HomePage() {
  const host = env.MISSKEY_HOST;
  return (
    <div className="space-y-4">
      <title>ブキチの絵文字工場</title>
      <h1 className="text-4xl font-bold tracking-tight">ブキチの絵文字工場</h1>
      <p className="text-gray-700">
        いかすきー (<a href={`https://${host}`} className="underline">{host}</a>) で利用するカスタム絵文字の申請窓口です。
      </p>
      <div className="space-x-3">
        <a
          href="/submit"
          className="inline-block rounded bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-700"
        >
          絵文字を申請する
        </a>
        <a href="/api/me" className="text-sm underline text-gray-600">ログイン状態</a>
      </div>
      <p className="text-xs text-gray-400">
        モデレーター画面 (/admin) は Phase 4 で実装します。
      </p>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};
