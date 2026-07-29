/**
 * Credentials for the Joshu Share Chat Teams bot (Azure Bot / Entra app).
 * Stored under .joshu/share-chat/ — secrets stay on the box, not in Composio.
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export type TeamsBotCreds = {
  /** Microsoft App ID (bot / Entra application client id). */
  appId: string;
  /** Client secret for the Entra app. */
  appPassword: string;
  /**
   * Entra tenant id for single-tenant bots.
   * Use "botframework.com" / omit for multi-tenant / personal MSA sideload.
   */
  tenantId?: string;
  /** Display name shown in the Teams app package. */
  displayName?: string;
  updatedAt: string;
};

function credsDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

export function teamsBotCredsPath(projectRoot = process.cwd()): string {
  return path.join(credsDir(projectRoot), "teams-bot.json");
}

export function readTeamsBotCreds(projectRoot = process.cwd()): TeamsBotCreds | null {
  const p = teamsBotCredsPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as TeamsBotCreds;
    if (!parsed?.appId?.trim() || !parsed?.appPassword?.trim()) return null;
    return {
      appId: parsed.appId.trim(),
      appPassword: parsed.appPassword.trim(),
      tenantId: parsed.tenantId?.trim() || undefined,
      displayName: parsed.displayName?.trim() || undefined,
      updatedAt: parsed.updatedAt || "",
    };
  } catch {
    return null;
  }
}

export function writeTeamsBotCreds(
  creds: Omit<TeamsBotCreds, "updatedAt">,
  projectRoot = process.cwd(),
): TeamsBotCreds {
  const dir = credsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const row: TeamsBotCreds = {
    appId: creds.appId.trim(),
    appPassword: creds.appPassword.trim(),
    tenantId: creds.tenantId?.trim() || undefined,
    displayName: creds.displayName?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  const filePath = teamsBotCredsPath(projectRoot);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(row, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return row;
}

export function teamsBotConfigured(projectRoot = process.cwd()): boolean {
  return Boolean(readTeamsBotCreds(projectRoot));
}

/** Prefer env overrides for operators; else on-disk Connectors wizard creds. */
export function resolveTeamsBotCreds(projectRoot = process.cwd()): TeamsBotCreds | null {
  const envId = process.env.JOSHU_TEAMS_BOT_APP_ID?.trim();
  const envSecret = process.env.JOSHU_TEAMS_BOT_APP_PASSWORD?.trim();
  if (envId && envSecret) {
    return {
      appId: envId,
      appPassword: envSecret,
      tenantId: process.env.JOSHU_TEAMS_BOT_TENANT_ID?.trim() || undefined,
      displayName: process.env.JOSHU_TEAMS_BOT_DISPLAY_NAME?.trim() || undefined,
      updatedAt: "",
    };
  }
  return readTeamsBotCreds(projectRoot);
}
