/**
 * Map Bot Framework conversation ids ↔ share UUIDs for Teams Share Chat.
 */

import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export type TeamsConversationBinding = {
  shareUuid: string;
  conversationId: string;
  /** personal | groupChat | channel */
  conversationType?: string;
  serviceUrl?: string;
  tenantId?: string;
  boundAt: string;
  updatedAt: string;
  enabled: boolean;
};

type RegistryFile = {
  version: 1;
  byShare: Record<string, TeamsConversationBinding>;
  byConversation: Record<string, string>;
};

function registryDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

function registryPath(projectRoot = process.cwd()): string {
  return path.join(registryDir(projectRoot), "teams-conversations.json");
}

function emptyRegistry(): RegistryFile {
  return { version: 1, byShare: {}, byConversation: {} };
}

function readRegistry(projectRoot = process.cwd()): RegistryFile {
  const p = registryPath(projectRoot);
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || parsed.version !== 1 || !parsed.byShare) return emptyRegistry();
    if (!parsed.byConversation) {
      const byConversation: Record<string, string> = {};
      for (const [shareUuid, row] of Object.entries(parsed.byShare)) {
        if (row?.conversationId) byConversation[row.conversationId] = shareUuid;
      }
      return { version: 1, byShare: parsed.byShare, byConversation };
    }
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(reg: RegistryFile, projectRoot = process.cwd()): void {
  const dir = registryDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${registryPath(projectRoot)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, registryPath(projectRoot));
}

function shareKey(shareUuid: string): string {
  return shareUuid.trim().toLowerCase();
}

export function getShareUuidForTeamsConversation(
  conversationId: string,
  projectRoot = process.cwd(),
): string | null {
  const id = conversationId.trim();
  if (!id) return null;
  return readRegistry(projectRoot).byConversation[id] || null;
}

export function getTeamsConversationForShare(
  shareUuid: string,
  projectRoot = process.cwd(),
): TeamsConversationBinding | null {
  const key = shareKey(shareUuid);
  if (!key) return null;
  return readRegistry(projectRoot).byShare[key] || null;
}

export function upsertTeamsConversationBinding(
  opts: {
    shareUuid: string;
    conversationId: string;
    conversationType?: string;
    serviceUrl?: string;
    tenantId?: string;
  },
  projectRoot = process.cwd(),
): TeamsConversationBinding {
  const shareUuid = shareKey(opts.shareUuid);
  const conversationId = opts.conversationId.trim();
  if (!shareUuid) throw new Error("share_uuid_required");
  if (!conversationId) throw new Error("conversation_id_required");

  const reg = readRegistry(projectRoot);
  const prev = reg.byShare[shareUuid];
  // Drop stale reverse index if conversation id changed
  if (prev?.conversationId && prev.conversationId !== conversationId) {
    delete reg.byConversation[prev.conversationId];
  }
  // If this conversation was bound to another share, clear that forward map
  const priorShare = reg.byConversation[conversationId];
  if (priorShare && priorShare !== shareUuid) {
    delete reg.byShare[priorShare];
  }

  const now = new Date().toISOString();
  const row: TeamsConversationBinding = {
    shareUuid,
    conversationId,
    conversationType: opts.conversationType,
    serviceUrl: opts.serviceUrl,
    tenantId: opts.tenantId,
    boundAt: prev?.boundAt || now,
    updatedAt: now,
    enabled: true,
  };
  reg.byShare[shareUuid] = row;
  reg.byConversation[conversationId] = shareUuid;
  writeRegistry(reg, projectRoot);
  return row;
}

export function unlinkTeamsConversation(
  shareUuid: string,
  projectRoot = process.cwd(),
): boolean {
  const key = shareKey(shareUuid);
  const reg = readRegistry(projectRoot);
  const row = reg.byShare[key];
  if (!row) return false;
  delete reg.byShare[key];
  if (row.conversationId) delete reg.byConversation[row.conversationId];
  writeRegistry(reg, projectRoot);
  return true;
}

export function publicTeamsBindingStatus(row: TeamsConversationBinding | null): {
  configured: boolean;
  conversationId?: string;
  conversationType?: string;
  boundAt?: string;
} {
  if (!row || !row.enabled) return { configured: false };
  return {
    configured: true,
    conversationId: row.conversationId,
    conversationType: row.conversationType,
    boundAt: row.boundAt,
  };
}
