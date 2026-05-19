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
    `申請者: @${args.applicantUsername}${args.applicantName ? ` (${args.applicantName})` : ''}`,
  );
  if (args.source === 'remote_copy') {
    lines.push(
      `取り込み元: \`:${args.sourceRemoteName ?? '?'}:\` @ ${args.sourceHost ?? '?'}`,
    );
  }
  lines.push(`カテゴリ: ${args.category || '(未指定)'}${args.categoryIsNew ? ' [新規]' : ''}`);
  lines.push(`エイリアス: ${args.aliases.length > 0 ? args.aliases.join(', ') : '(なし)'}`);
  if (args.comment) lines.push(`\nコメント: ${args.comment}`);
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
    `申請者: @${args.applicantUsername}`,
    `カテゴリ: ${args.category ?? '(未指定)'}`,
    `決裁者: @${args.decidedByUsername}`,
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
    `申請者: @${args.applicantUsername}`,
    `理由: ${args.reason}`,
    `決裁者: @${args.decidedByUsername}`,
    '',
    `**[→ 申請詳細を見る](${args.adminUrl})**`,
  ].join('\n');
}
