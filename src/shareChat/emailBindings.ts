/**
 * Per-share Email Q&A bindings — map allowed senders on the agent mailbox
 * to a share UUID (scoped share-chat answers, no EA ingress).
 */

import fs from "node:fs";
import path from "node:path";
import { parseEmailAddress } from "../ea/schedulingTypes.js";
import { readAgentGrant } from "../nylas/store.js";
import { joshuConfigDir } from "../nylas/paths.js";

const MAX_PROCESSED_IDS = 500;

export type ShareEmailBinding = {
  shareUuid: string;
  /** Normalized entries: `@domain.com` or `user@domain.com`. */
  allowedSenders: string[];
  cc: string[];
  processedMessageIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type RegistryFile = {
  version: 1;
  byShare: Record<string, ShareEmailBinding>;
};

function registryDir(projectRoot = process.cwd()): string {
  const joshu = joshuConfigDir(projectRoot);
  if (joshu) return path.join(joshu, "share-chat");
  return path.join(projectRoot, ".local", "share-chat");
}

function registryPath(projectRoot = process.cwd()): string {
  return path.join(registryDir(projectRoot), "email-bindings.json");
}

function emptyRegistry(): RegistryFile {
  return { version: 1, byShare: {} };
}

function readRegistry(projectRoot = process.cwd()): RegistryFile {
  const p = registryPath(projectRoot);
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || parsed.version !== 1 || !parsed.byShare) return emptyRegistry();
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

/** Normalize one allowlist entry from UI/API input. */
export function normalizeAllowedSender(raw: string): string | null {
  let entry = String(raw || "").trim().toLowerCase();
  if (!entry) return null;
  if (entry.startsWith("@")) {
    const domain = entry.slice(1).replace(/^@+/, "");
    if (!domain.includes(".") || /\s/.test(domain)) return null;
    return `@${domain}`;
  }
  const email = parseEmailAddress(entry) ?? (entry.includes("@") ? entry : null);
  if (!email || !email.includes("@")) return null;
  return email;
}

/** Parse comma/newline-separated allowlist from dialog or API body. */
export function parseAllowedSendersList(raw: unknown): string[] {
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const row of raw) items.push(String(row ?? ""));
  } else if (typeof raw === "string") {
    items.push(...raw.split(/[\n,;]+/));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const norm = normalizeAllowedSender(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/** Parse CC list (full emails only). */
export function parseCcList(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parseAllowedSendersList(raw)) {
    if (entry.startsWith("@")) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export function senderMatchesAllowed(senderEmail: string, allowedSenders: string[]): boolean {
  const sender = (parseEmailAddress(senderEmail) ?? senderEmail).trim().toLowerCase();
  if (!sender.includes("@")) return false;
  const domain = `@${sender.split("@").pop()}`;
  for (const rule of allowedSenders) {
    if (rule.startsWith("@")) {
      if (domain === rule) return true;
    } else if (sender === rule) {
      return true;
    }
  }
  return false;
}

function matchScore(senderEmail: string, allowedSenders: string[]): number {
  const sender = (parseEmailAddress(senderEmail) ?? senderEmail).trim().toLowerCase();
  let best = 0;
  for (const rule of allowedSenders) {
    if (rule.startsWith("@")) {
      if (`@${sender.split("@").pop()}` === rule) best = Math.max(best, 1);
    } else if (sender === rule) {
      best = Math.max(best, 2);
    }
  }
  return best;
}

export function resolveAgentMailboxEmail(projectRoot = process.cwd()): string | null {
  return readAgentGrant(projectRoot)?.email?.trim().toLowerCase() ?? null;
}

export function getShareEmailBinding(
  shareUuid: string,
  projectRoot = process.cwd(),
): ShareEmailBinding | null {
  const key = shareKey(shareUuid);
  if (!key) return null;
  return readRegistry(projectRoot).byShare[key] || null;
}

export function listEnabledEmailBindings(projectRoot = process.cwd()): ShareEmailBinding[] {
  return Object.values(readRegistry(projectRoot).byShare).filter((row) => row?.enabled);
}

/** Best matching share for an inbound sender (exact email beats domain). */
export function findShareForEmailSender(
  senderEmail: string,
  projectRoot = process.cwd(),
): ShareEmailBinding | null {
  const sender = parseEmailAddress(senderEmail) ?? senderEmail;
  if (!sender.includes("@")) return null;

  let best: ShareEmailBinding | null = null;
  let bestScore = 0;
  let bestUpdated = "";

  for (const row of listEnabledEmailBindings(projectRoot)) {
    if (!row.allowedSenders.length) continue;
    const score = matchScore(sender, row.allowedSenders);
    if (score === 0) continue;
    if (
      score > bestScore ||
      (score === bestScore && row.updatedAt > bestUpdated)
    ) {
      best = row;
      bestScore = score;
      bestUpdated = row.updatedAt;
    }
  }
  return best;
}

export function upsertShareEmailBinding(
  opts: {
    shareUuid: string;
    allowedSenders: string[];
    cc?: string[];
  },
  projectRoot = process.cwd(),
): ShareEmailBinding {
  const shareUuid = shareKey(opts.shareUuid);
  if (!shareUuid) throw new Error("share_uuid_required");
  const allowedSenders = parseAllowedSendersList(opts.allowedSenders);
  if (allowedSenders.length === 0) throw new Error("allowed_senders_required");

  const reg = readRegistry(projectRoot);
  const prev = reg.byShare[shareUuid];
  const now = new Date().toISOString();
  const row: ShareEmailBinding = {
    shareUuid,
    allowedSenders,
    cc: parseCcList(opts.cc ?? prev?.cc ?? []),
    processedMessageIds: prev?.processedMessageIds ?? [],
    enabled: true,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  reg.byShare[shareUuid] = row;
  writeRegistry(reg, projectRoot);
  return row;
}

export function unlinkShareEmailBinding(shareUuid: string, projectRoot = process.cwd()): boolean {
  const key = shareKey(shareUuid);
  const reg = readRegistry(projectRoot);
  if (!reg.byShare[key]) return false;
  delete reg.byShare[key];
  writeRegistry(reg, projectRoot);
  return true;
}

export function isEmailMessageProcessed(
  shareUuid: string,
  messageId: string,
  projectRoot = process.cwd(),
): boolean {
  const id = messageId.trim();
  if (!id) return false;
  const row = getShareEmailBinding(shareUuid, projectRoot);
  return Boolean(row?.processedMessageIds.includes(id));
}

export function markEmailMessageProcessed(
  shareUuid: string,
  messageId: string,
  projectRoot = process.cwd(),
): void {
  const key = shareKey(shareUuid);
  const id = messageId.trim();
  if (!key || !id) return;
  const reg = readRegistry(projectRoot);
  const row = reg.byShare[key];
  if (!row) return;
  if (row.processedMessageIds.includes(id)) return;
  row.processedMessageIds = [...row.processedMessageIds, id].slice(-MAX_PROCESSED_IDS);
  row.updatedAt = new Date().toISOString();
  reg.byShare[key] = row;
  writeRegistry(reg, projectRoot);
}

export function publicEmailBindingStatus(
  shareUuid: string,
  projectRoot = process.cwd(),
): {
  configured: boolean;
  allowedSenders?: string[];
  cc?: string[];
  processedCount?: number;
  updatedAt?: string;
} {
  const row = getShareEmailBinding(shareUuid, projectRoot);
  if (!row || !row.enabled || row.allowedSenders.length === 0) {
    return { configured: false };
  }
  return {
    configured: true,
    allowedSenders: row.allowedSenders,
    cc: row.cc,
    processedCount: row.processedMessageIds.length,
    updatedAt: row.updatedAt,
  };
}
