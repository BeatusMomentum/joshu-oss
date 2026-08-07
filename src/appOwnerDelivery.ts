/**
 * Notify box owner via configured owner channel (Slack / Telegram).
 */

import { readOwnerChannelConfig } from "./ownerChannel/config.js";
import { sendSlackViaComposio, sendTelegramViaComposio } from "./ownerChannel/composioSend.js";

export type AppOwnerDeliveryInput = {
  appId: string;
  title: string;
  summary: string;
  link?: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send a short app event summary to owner Slack/Telegram when configured. */
export async function notifyOwnerAppEvent(
  input: AppOwnerDeliveryInput,
  projectRoot: string,
): Promise<{ delivered: boolean; channels: string[] }> {
  const cfg = readOwnerChannelConfig(projectRoot);
  if (!cfg) return { delivered: false, channels: [] };

  const channels: string[] = [];
  const body = input.link
    ? `${input.summary}\n\n${input.link}`
    : input.summary;
  const telegramText = `<b>${escapeHtml(input.title)}</b>\n${escapeHtml(body)}`;
  const slackText = `*${input.title}*\n${body}`;

  if (cfg.notify.telegramChatId?.trim()) {
    await sendTelegramViaComposio(
      {
        chatId: cfg.notify.telegramChatId.trim(),
        text: telegramText,
        connectedAccountId: cfg.connectedAccountId,
      },
      projectRoot,
    );
    channels.push("telegram");
  }

  if (cfg.notify.slackDmChannelId?.trim()) {
    await sendSlackViaComposio(
      {
        channel: cfg.notify.slackDmChannelId.trim(),
        text: slackText,
        connectedAccountId: cfg.connectedAccountId,
      },
      projectRoot,
    );
    channels.push("slack");
  }

  return { delivered: channels.length > 0, channels };
}
