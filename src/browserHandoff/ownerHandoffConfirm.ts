/**
 * Owner confirmed handoff completion out-of-band (SMS / chat) — no handoff-page button required.
 */

import { completeHandoff, getPendingHandoff, type BrowserHandoffRecord } from "./store.js";

/** Normalize owner text for optional completion-intent matching (agent helper fallback). */
function normalizeOwnerConfirmText(body: string): string {
  return body.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Optional phrase match for agent-initiated complete when no session key is available.
 * SMS uses session-based auto-complete instead (see tryCompletePendingHandoffForOwnerSession).
 */
export function looksLikeOwnerHandoffComplete(body: string): boolean {
  const text = normalizeOwnerConfirmText(body);
  if (!text) return false;
  if (text.length > 240) return false;

  const patterns = [
    /\b(i'?m|i am|yeah i'?m|yes i'?m)\s+done\b/,
    /\bdone\s+with\b/,
    /\bfinished\s+with\b/,
    /\b(i'?m|i am)\s+finished\b/,
    /\ball\s+set\b/,
    /\bgood\s+to\s+go\b/,
    /\bthat\s+worked\b/,
    /\bhandoff\s+done\b/,
    /\bcompleted\s+(the\s+)?(login|sign[\s-]?in|handoff)\b/,
    /^done[.!]?$/,
    /^finished[.!]?$/,
  ];
  return patterns.some((re) => re.test(text));
}

/** Match sms:+1… session keys across idle rotation (epoch suffix may differ). */
export function smsSessionKeysCompatible(handoffKey: string, inboundKey: string): boolean {
  if (handoffKey === inboundKey) return true;
  if (!handoffKey.startsWith("sms:") || !inboundKey.startsWith("sms:")) return false;
  const handoffPhone = handoffKey.slice(4).split(":")[0]?.trim();
  const inboundPhone = inboundKey.slice(4).split(":")[0]?.trim();
  return Boolean(handoffPhone && inboundPhone && handoffPhone === inboundPhone);
}

function pendingMatchesSession(
  pending: BrowserHandoffRecord,
  hermesSessionKey?: string,
): boolean {
  const bound = pending.hermesSessionKey?.trim();
  if (!bound) return true;
  const inbound = hermesSessionKey?.trim();
  if (!inbound) return false;
  if (bound === inbound) return true;
  return smsSessionKeysCompatible(bound, inbound);
}

export type OwnerHandoffConfirmInput = {
  body: string;
  hermesSessionKey?: string;
};

/**
 * Complete the pending handoff when the owner confirms done in chat (phrase match).
 * Prefer tryCompletePendingHandoffForOwnerSession for owner SMS.
 */
export function tryCompletePendingHandoffFromOwnerConfirm(
  projectRoot: string,
  input: OwnerHandoffConfirmInput,
): BrowserHandoffRecord | null {
  if (!looksLikeOwnerHandoffComplete(input.body)) return null;
  return tryCompletePendingHandoffForOwnerSession(projectRoot, input.hermesSessionKey);
}

/**
 * Complete the pending handoff for this owner session — any inbound message counts as moving on.
 * Used on owner SMS preflight so the browser unlocks before the agent's turn.
 */
export function tryCompletePendingHandoffForOwnerSession(
  projectRoot: string,
  hermesSessionKey?: string,
): BrowserHandoffRecord | null {
  const pending = getPendingHandoff(projectRoot);
  if (!pending) return null;
  if (!pendingMatchesSession(pending, hermesSessionKey)) return null;
  return completeHandoff(projectRoot, pending.id);
}
