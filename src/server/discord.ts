/**
 * Discord webhook 通知。DISCORD_WEBHOOK_URL secret が未設定なら無害な no-op。
 */
export async function notifyDiscord(
  env: Env,
  payload: {
    title: string;
    description: string;
    url?: string;
    imageUrl?: string;
    color?: number;
  },
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.warn('[discord] DISCORD_WEBHOOK_URL not set, skipping notification');
    return;
  }
  try {
    const r = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: payload.title,
            description: payload.description,
            url: payload.url,
            color: payload.color ?? 0x4ea3ff,
            image: payload.imageUrl ? { url: payload.imageUrl } : undefined,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!r.ok) {
      console.error(`[discord] webhook returned ${r.status}: ${await r.text()}`);
    }
  } catch (e) {
    console.error('[discord] webhook error:', e);
  }
}
