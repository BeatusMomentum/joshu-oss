import type { BrowserHandoffRecord } from "./store.js";
import { isBrowserHandoffLocked } from "./store.js";

export type BrowserHandoffLockStub = {
  success: false;
  error: "browser_handoff_locked";
  message: string;
  handoffId: string;
  pageUrl: string;
};

/** Hermes / action-guard stub when agent browser ops are blocked during owner handoff. */
export function browserHandoffLockStub(projectRoot: string): BrowserHandoffLockStub | null {
  const lock = isBrowserHandoffLocked(projectRoot);
  if (!lock.locked || !lock.handoffId || !lock.pageUrl) return null;
  return {
    success: false,
    error: "browser_handoff_locked",
    message:
      "Browser is locked for owner mobile handoff. Wait for browser_handoff_status=completed before navigating or clicking.",
    handoffId: lock.handoffId,
    pageUrl: lock.pageUrl,
  };
}

export function publicHandoffView(record: BrowserHandoffRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    instructions: record.instructions,
    expiresAt: record.expiresAt,
    completedAt: record.completedAt,
  };
}
