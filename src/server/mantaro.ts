/**
 * スーパーマンタロー名義での Misskey API 呼び出しクライアント。
 * MANTARO_TOKEN (write:admin:emoji + write:drive + write:notes 等) を持つ前提。
 */

function base(env: Env): string {
  return `https://${env.MISSKEY_HOST}/api`;
}

async function call<T = unknown>(
  env: Env,
  ep: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(`${base(env)}/${ep}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, i: env.MANTARO_TOKEN }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`mantaro ${ep} failed: ${r.status} ${text.slice(0, 200)}`);
  }
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return (await r.json()) as T;
  }
  return null as unknown as T;
}

export type DriveFile = {
  id: string;
  type: string;
  size: number;
  name: string;
  url: string;
};

/**
 * mantaro のドライブに File を multipart アップロード。
 */
export async function mantaroUploadDriveBlob(
  env: Env,
  fileName: string,
  blob: Blob,
): Promise<DriveFile> {
  const fd = new FormData();
  fd.append('i', env.MANTARO_TOKEN);
  fd.append('file', blob, fileName);
  // force=true: 同名ファイルでも常に新規作成
  fd.append('force', 'true');
  const r = await fetch(`${base(env)}/drive/files/create`, {
    method: 'POST',
    body: fd,
  });
  if (!r.ok) {
    throw new Error(`drive/files/create failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as DriveFile;
}

export type EmojiAddArgs = {
  name: string;
  fileId: string;
  category?: string | null;
  aliases?: string[];
  license?: string | null;
  isSensitive?: boolean;
  localOnly?: boolean;
};

export type EmojiAddResult = {
  id: string;
  name: string;
  url: string;
  category: string | null;
};

export async function mantaroEmojiAdd(
  env: Env,
  args: EmojiAddArgs,
): Promise<EmojiAddResult> {
  return call<EmojiAddResult>(env, 'admin/emoji/add', args as Record<string, unknown>);
}

export async function mantaroNotesCreate(
  env: Env,
  args: {
    text: string;
    replyId?: string;
    visibility?: 'public' | 'home' | 'followers' | 'specified';
    // visibility が 'specified' (ダイレクト) のときは必須。
    // 指定しないと Misskey 側で visibleUserIds が空となり、
    // 誰にも (申請者にも) 見えないノートになってしまう。
    visibleUserIds?: string[];
    localOnly?: boolean;
  },
): Promise<{ createdNote: { id: string } }> {
  return call(env, 'notes/create', args as Record<string, unknown>);
}

export type RemoteEmoji = {
  id: string;
  name: string;
  host: string | null;
  url: string;
  aliases: string[];
  category: string | null;
};

/**
 * リモート (他鯖) emoji を host + name で検索。
 * ikaskey にすでにキャッシュされている (受信した) emoji のみヒットする。
 * 未受信のものは取得不可 (Misskey の仕様)。
 */
export async function mantaroListRemote(
  env: Env,
  host: string,
  query: string,
  limit = 5,
): Promise<RemoteEmoji[]> {
  const r = await call<RemoteEmoji[]>(env, 'admin/emoji/list-remote', {
    host,
    query,
    limit,
  });
  return Array.isArray(r) ? r : [];
}

/**
 * リモート (キャッシュ済) emoji をローカルに copy。
 * 戻り値は新しくローカルに作られた emoji の id。
 */
export async function mantaroEmojiCopy(
  env: Env,
  emojiId: string,
): Promise<{ id: string }> {
  return call(env, 'admin/emoji/copy', { emojiId });
}

/**
 * 既存ローカル emoji の name / category / aliases を更新。
 * admin/emoji/copy 直後の rename に使う。
 */
export async function mantaroEmojiUpdate(
  env: Env,
  args: {
    id: string;
    name?: string;
    category?: string | null;
    aliases?: string[];
  },
): Promise<void> {
  await call(env, 'admin/emoji/update', args as Record<string, unknown>);
}
