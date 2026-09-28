/** Slack and Telegram senders for owner outbox items. */
import { createHash } from "node:crypto";

import { buildHermesMessagingDotenvEntries } from "../hermesMessagingEnv.js";

type SendResult = { delivered: boolean; providerId?: string; error?: string };

/** Slack `client_msg_id` is a UUID; derive it so a retried post is deduplicated. */
function slackClientMsgId(dedupeKey: string): string {
  const hex = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function postSlackMessage(
  projectRoot: string,
  input: { channel?: string; threadTs?: string; text: string; dedupeKey: string },
): Promise<SendResult> {
  const token = buildHermesMessagingDotenvEntries(projectRoot).SLACK_BOT_TOKEN?.trim();
  const channel = input.channel?.trim();
  if (!token || !channel) return { delivered: false, error: "Slack delivery is not configured" };
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: input.text,
      client_msg_id: slackClientMsgId(input.dedupeKey),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    ts?: string;
    error?: string;
  };
  return body.ok
    ? { delivered: true, providerId: body.ts }
    : { delivered: false, error: body.error || `Slack HTTP ${response.status}` };
}

export async function sendTelegramMessage(
  projectRoot: string,
  input: { chatId?: string; threadId?: string; text: string },
): Promise<SendResult> {
  const token = buildHermesMessagingDotenvEntries(projectRoot).TELEGRAM_BOT_TOKEN?.trim();
  const chatId = input.chatId?.trim();
  if (!token || !chatId) return { delivered: false, error: "Telegram delivery is not configured" };
  const text = input.text;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.length > 4_000 ? `${text.slice(0, 3_997)}...` : text,
      ...(input.threadId && /^\d+$/.test(input.threadId)
        ? { message_thread_id: Number(input.threadId) }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  };
  return body.ok
    ? { delivered: true, providerId: String(body.result?.message_id ?? "") || undefined }
    : { delivered: false, error: body.description || `Telegram HTTP ${response.status}` };
}
