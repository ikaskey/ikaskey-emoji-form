/**
 * 申請バリデーション (Misskey の admin/emoji/add 要件に準拠)。
 */

export const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;
export const NAME_MAX_LENGTH = 60;
export const CATEGORY_MAX_LENGTH = 200;
export const ALIAS_MAX_LENGTH = 60;
export const ALIASES_MAX_COUNT = 20;
export const COMMENT_MAX_LENGTH = 1000;

export const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/apng',
  'image/avif',
]);

export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB (Misskey デフォルト相当)

export type MetaInput = {
  name: string;
  category: string;
  categoryIsNew: boolean;
  aliases: string[];
  comment: string;
};

export type SubmitInput = MetaInput & { file: File };

export type ValidationError = { field: string; message: string };

/** 名前・カテゴリ・エイリアス・コメントの検証。アップロード・取り込みの両経路で使う。 */
export function validateMeta(input: MetaInput): ValidationError[] {
  const errs: ValidationError[] = [];

  if (!input.name) {
    errs.push({ field: 'name', message: '絵文字名を入力してください' });
  } else if (!NAME_PATTERN.test(input.name)) {
    errs.push({
      field: 'name',
      message: '絵文字名は半角英数字とアンダースコア (_) のみ使用できます',
    });
  } else if (input.name.length > NAME_MAX_LENGTH) {
    errs.push({
      field: 'name',
      message: `絵文字名は ${NAME_MAX_LENGTH} 文字以内にしてください`,
    });
  }

  if (!input.category.trim()) {
    errs.push({
      field: 'category',
      message: input.categoryIsNew ? '新カテゴリ名を入力してください' : 'カテゴリを選択してください',
    });
  }
  if (input.category.length > CATEGORY_MAX_LENGTH) {
    errs.push({ field: 'category', message: 'カテゴリ名が長すぎます' });
  }

  if (input.aliases.length > ALIASES_MAX_COUNT) {
    errs.push({
      field: 'aliases',
      message: `エイリアスは ${ALIASES_MAX_COUNT} 個までにしてください`,
    });
  }
  for (const a of input.aliases) {
    if (a.length > ALIAS_MAX_LENGTH) {
      errs.push({
        field: 'aliases',
        message: `エイリアスが長すぎます: "${a.slice(0, 20)}…"`,
      });
      break;
    }
  }

  if (input.comment.length > COMMENT_MAX_LENGTH) {
    errs.push({
      field: 'comment',
      message: `コメントは ${COMMENT_MAX_LENGTH} 文字以内にしてください`,
    });
  }

  return errs;
}

export function validateSubmit(input: SubmitInput): ValidationError[] {
  const errs = validateMeta(input);

  if (!input.file) {
    errs.push({ field: 'file', message: '画像ファイルを選択してください' });
  } else {
    if (!ALLOWED_MIME_TYPES.has(input.file.type)) {
      errs.push({
        field: 'file',
        message: `対応していないファイル形式です: ${input.file.type}`,
      });
    }
    if (input.file.size > MAX_FILE_SIZE) {
      errs.push({
        field: 'file',
        message: `ファイルが大きすぎます (${Math.ceil(MAX_FILE_SIZE / 1024 / 1024)} MiB まで)`,
      });
    }
    if (input.file.size === 0) {
      errs.push({ field: 'file', message: 'ファイルが空です' });
    }
  }

  return errs;
}

/**
 * フォームから来る生の aliases 文字列を配列に正規化。
 * カンマ・読点 (、) 区切り。前後空白を取って空要素は除く。
 */
export function parseAliases(raw: string): string[] {
  return raw
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 先頭バイトから画像形式を判定する。申告された MIME (ブラウザがファイル名から決める値) は
 * 偽れるため、中身が本当にその形式かを確かめるのに使う。判定できなければ null。
 * APNG は PNG と同じ先頭バイトなので 'image/png' を返す。
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, s: string) =>
    [...s].every((ch, i) => at(start + i) === ch.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  return null;
}

/** 申告 MIME と中身の形式が一致するか。 */
export function imageContentMatches(declaredMime: string, bytes: Uint8Array): boolean {
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) return false;
  const declared = declaredMime === 'image/apng' ? 'image/png' : declaredMime;
  return declared === sniffed;
}
