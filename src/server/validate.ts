/**
 * 申請バリデーション (Misskey の admin/emoji/add 要件に準拠)。
 */

export const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;
export const NAME_MAX_LENGTH = 60;

export const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/apng',
  'image/avif',
]);

export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MiB (Misskey デフォルト相当)

export type SubmitInput = {
  name: string;
  category: string;
  categoryIsNew: boolean;
  aliases: string[];
  comment: string;
  file: File;
};

export type ValidationError = { field: string; message: string };

export function validateSubmit(input: SubmitInput): ValidationError[] {
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

  if (input.categoryIsNew && !input.category.trim()) {
    errs.push({
      field: 'category',
      message: '新カテゴリ名を入力してください',
    });
  }
  if (input.category.length > 200) {
    errs.push({ field: 'category', message: 'カテゴリ名が長すぎます' });
  }

  for (const a of input.aliases) {
    if (a.length > 60) {
      errs.push({
        field: 'aliases',
        message: `エイリアスが長すぎます: "${a.slice(0, 20)}…"`,
      });
      break;
    }
  }

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
