/**
 * Bot Framework connector auth: outbound token + inbound JWT verification.
 * Lightweight alternative to full botbuilder for share-chat Teams replies.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { resolveTeamsBotCreds, type TeamsBotCreds } from "./teamsBotCreds.js";

const BOT_OPENID =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TO_BOT_FROM_CHANNEL = "https://api.botframework.com";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function openIdConfig(): Promise<{ jwks_uri: string; issuer: string }> {
  const res = await fetch(BOT_OPENID);
  if (!res.ok) throw new Error(`bot_openid_config_failed:${res.status}`);
  return (await res.json()) as { jwks_uri: string; issuer: string };
}

async function getJwks() {
  if (jwks) return jwks;
  const cfg = await openIdConfig();
  jwks = createRemoteJWKSet(new URL(cfg.jwks_uri));
  return jwks;
}

/**
 * Verify Bot Framework Authorization bearer JWT on inbound activities.
 * Skipped only when JOSHU_TEAMS_BOT_SKIP_AUTH=true (local smoke).
 */
export async function verifyTeamsBotAuthHeader(
  authHeader: string | undefined,
  creds: TeamsBotCreds,
): Promise<boolean> {
  if (process.env.JOSHU_TEAMS_BOT_SKIP_AUTH?.trim() === "true") return true;
  if (!authHeader?.toLowerCase().startsWith("bearer ")) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;

  try {
    const keys = await getJwks();
    // Audience varies (app id and/or https://api.botframework.com) — validate manually.
    const { payload } = await jwtVerify(token, keys, {
      clockTolerance: 60,
    });
    const aud = payload.aud;
    const audOk =
      aud === creds.appId ||
      aud === TO_BOT_FROM_CHANNEL ||
      (Array.isArray(aud) &&
        (aud.includes(creds.appId) || aud.includes(TO_BOT_FROM_CHANNEL)));
    if (!audOk) return false;
    return true;
  } catch (err) {
    console.warn(
      "[share-chat/teams-bot] jwt verify failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function tokenEndpoint(creds: TeamsBotCreds): string {
  const tenant = creds.tenantId?.trim();
  // Multi-tenant / MSA-friendly bots use botframework.com; single-tenant uses Entra tenant.
  if (tenant && tenant !== "botframework.com" && tenant !== "common") {
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  }
  return "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
}

/** OAuth client-credentials token for Bot Connector replies. */
export async function getTeamsBotAccessToken(
  projectRoot = process.cwd(),
): Promise<string> {
  const creds = resolveTeamsBotCreds(projectRoot);
  if (!creds) throw new Error("teams_bot_not_configured");

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope: "https://api.botframework.com/.default",
  });

  const res = await fetch(tokenEndpoint(creds), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`teams_bot_token_failed:${res.status}:${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("teams_bot_token_missing");
  const expiresIn = Number(json.expires_in || 3600);
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + expiresIn * 1000,
  };
  return json.access_token;
}

/** Clear cached token (after rotating secrets). */
export function clearTeamsBotTokenCache(): void {
  cachedToken = null;
}

export type BotActivity = {
  type?: string;
  id?: string;
  timestamp?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    isGroup?: boolean;
  };
  recipient?: { id?: string; name?: string };
  text?: string;
  textFormat?: string;
  membersAdded?: Array<{ id?: string }>;
  channelData?: Record<string, unknown>;
  /** Present on replies / mentions */
  entities?: unknown[];
};

/** Post a message activity into an existing conversation. */
export async function sendTeamsBotReply(opts: {
  serviceUrl: string;
  conversationId: string;
  text: string;
  replyToId?: string;
  projectRoot?: string;
}): Promise<void> {
  const token = await getTeamsBotAccessToken(opts.projectRoot);
  const base = opts.serviceUrl.replace(/\/+$/, "");
  const url = `${base}/v3/conversations/${encodeURIComponent(opts.conversationId)}/activities`;
  const activity: Record<string, unknown> = {
    type: "message",
    text: opts.text,
  };
  if (opts.replyToId) {
    activity.replyToId = opts.replyToId;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(activity),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`teams_bot_reply_failed:${res.status}:${text.slice(0, 300)}`);
  }
}
