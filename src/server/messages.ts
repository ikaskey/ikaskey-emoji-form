/**
 * スーパーマンタロー名義の note 本文 + Discord 通知本文を一元管理。
 * 文面を変えたい時はこのファイルだけ編集すれば全箇所に反映される。
 */

// =====================================================================
// mantaro が投稿する note の本文
// =====================================================================

/** 採用時に申請者に届く note */
export function approvedNote(args: {
  applicantUsername: string;
  emojiName: string;
}): string {
  const { applicantUsername, emojiName } = args;
  return `@${applicantUsername} :ei_mantaro_bigman: エイエーイ！（:${emojiName}: を絵文字工場のラインに並べたよ！ ご申請ありがとね！）`;
}

/** 却下時に申請者に届く note */
export function rejectedNote(args: {
  applicantUsername: string;
  applicationName: string;
  reason: string;
}): string {
  const { applicantUsername, applicationName, reason } = args;
  return `@${applicantUsername} :ei_mantaro_bigman: エイ……（ごめんね、:${applicationName}: は今回採用を見送らせてもらったよ。
理由: ${reason}
また気軽に申請してね！）`;
}

// =====================================================================
// Discord webhook の embed 本文
// =====================================================================

/**
 * 申請者・モデレーターが入力した文字列を Discord の Markdown として解釈させない。
 * (コメントに [承認画面](https://evil.example) のような偽リンクを書かれるのを防ぐ)
 */
function md(s: string): string {
  return s.replace(/[\\*_~`|>#\[\]()<:-]/g, '\\$&');
}

/** 申請受付時 Discord 通知 description */
export function submittedDiscord(args: {
  applicantUsername: string;
  applicantName: string | null;
  category: string;
  categoryIsNew: boolean;
  aliases: string[];
  comment: string;
  source: 'upload' | 'remote_copy';
  sourceHost?: string | null;
  sourceRemoteName?: string | null;
  adminUrl: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `申請者: @${md(args.applicantUsername)}${args.applicantName ? ` (${md(args.applicantName)})` : ''}`,
  );
  if (args.source === 'remote_copy') {
    lines.push(
      `取り込み元: :${md(args.sourceRemoteName ?? '?')}: @ ${md(args.sourceHost ?? '?')}`,
    );
  }
  lines.push(`カテゴリ: ${args.category ? md(args.category) : '(未指定)'}${args.categoryIsNew ? ' [新規]' : ''}`);
  lines.push(`エイリアス: ${args.aliases.length > 0 ? md(args.aliases.join(', ')) : '(なし)'}`);
  if (args.comment) lines.push(`\nコメント: ${md(args.comment)}`);
  lines.push('');
  lines.push(`**[→ 承認画面を開く](${args.adminUrl})**`);
  return lines.join('\n');
}

/** 採用通知 Discord description */
export function approvedDiscord(args: {
  applicantUsername: string;
  category: string | null;
  decidedByUsername: string;
  adminUrl: string;
}): string {
  return [
    `申請者: @${md(args.applicantUsername)}`,
    `カテゴリ: ${args.category ? md(args.category) : '(未指定)'}`,
    `決裁者: @${md(args.decidedByUsername)}`,
    '',
    `**[→ 申請詳細を見る](${args.adminUrl})**`,
  ].join('\n');
}

/** 却下通知 Discord description */
export function rejectedDiscord(args: {
  applicantUsername: string;
  reason: string;
  decidedByUsername: string;
  adminUrl: string;
}): string {
  return [
    `申請者: @${md(args.applicantUsername)}`,
    `理由: ${md(args.reason)}`,
    `決裁者: @${md(args.decidedByUsername)}`,
    '',
    `**[→ 申請詳細を見る](${args.adminUrl})**`,
  ].join('\n');
}
