/**
 * Discord webhook 通知。DISCORD_WEBHOOK_URL secret が未設定なら無害な no-op。
 *
 * 画像添付がある場合は multipart/form-data + payload_json + files[0] で送信し、
 * embed の image.url に attachment://<filename> を参照させる。
 * 画像なしの場合は application/json で従来通り。
 */
export async function notifyDiscord(
  env: Env,
  payload: {
    title: string;
    description: string;
    url?: string;
    /** 直接 URL 指定の embed image (Discord が取れる必要あり) */
    imageUrl?: string;
    color?: number;
    /** ローカルにあるバイト列を attachment として送る場合 */
    attachment?: { filename: string; blob: Blob };
  },
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.warn('[discord] DISCORD_WEBHOOK_URL not set, skipping notification');
    return;
  }

  // Discord は attachment filename に英数とドット・アンダースコア・ハイフン以外を嫌うことがある
  const safeFilename = payload.attachment
    ? payload.attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    : undefined;

  const embed: Record<string, unknown> = {
    title: payload.title,
    description: payload.description,
    url: payload.url,
    color: payload.color ?? 0x4ea3ff,
    timestamp: new Date().toISOString(),
  };
  if (payload.attachment && safeFilename) {
    embed.image = { url: `attachment://${safeFilename}` };
  } else if (payload.imageUrl) {
    embed.image = { url: payload.imageUrl };
  }

  try {
    let r: Response;
    if (payload.attachment && safeFilename) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ embeds: [embed] }));
      fd.append('files[0]', payload.attachment.blob, safeFilename);
      r = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: fd });
    } else {
      r = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    }
    if (!r.ok) {
      console.error(`[discord] webhook returned ${r.status}: ${await r.text()}`);
    }
  } catch (e) {
    console.error('[discord] webhook error:', e);
  }
}
