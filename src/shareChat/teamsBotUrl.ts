/**
 * Public messaging endpoint URL helpers for the Teams Share Chat bot.
 */

import { resolveJoshuPublicApiBase } from "../ownerChannel/publicUrl.js";

export function teamsBotMessagesPath(): string {
  return `/api/share-chat/teams/messages`;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return true;
  }
}

function originFromEnvUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

/** Azure Bot → Configuration → Messaging endpoint. */
export function teamsBotMessagesRequestUrl(): string {
  const apiBase = resolveJoshuPublicApiBase().replace(/\/+$/, "");
  if (!isLoopbackUrl(apiBase)) {
    return `${apiBase}${teamsBotMessagesPath()}`;
  }

  const tunnelOrigin =
    originFromEnvUrl(process.env.TWILIO_VOICE_WEBHOOK_URL) ||
    originFromEnvUrl(process.env.PHONE_VOICE_PUBLIC_HOST) ||
    originFromEnvUrl(process.env.JOSHU_PUBLIC_URL);
  if (tunnelOrigin && !isLoopbackUrl(tunnelOrigin)) {
    const basePath = (process.env.PUBLIC_BASE_PATH || "/joshu").replace(/\/+$/, "") || "/joshu";
    return `${tunnelOrigin}${basePath}${teamsBotMessagesPath()}`;
  }

  return `${apiBase}${teamsBotMessagesPath()}`;
}

export function teamsBotMessagesUrlIsPublic(): boolean {
  return !isLoopbackUrl(teamsBotMessagesRequestUrl());
}
