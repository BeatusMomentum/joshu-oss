/**
 * When owner SMS/jChat should route through proactive resolve vs generic chat.
 *
 * First reply clears feedbackPending (so unrelated texts are not hijacked), but
 * follow-ups within a short window still attach to lastNudge via lastOwnerReplyAt.
 */

import { parseProactiveTaskRef } from "./blockReason.js";
import type { ProactiveState } from "./types.js";

/** Default: 2 hours after nudge or last owner reply on that thread. */
export const PROACTIVE_FOLLOWUP_WINDOW_MS_DEFAULT = 2 * 60 * 60_000;

export function resolveProactiveFollowUpWindowMs(): number {
  const raw = process.env.JOSHU_PROACTIVE_REPLY_FOLLOWUP_MINUTES?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n * 60_000;
  }
  return PROACTIVE_FOLLOWUP_WINDOW_MS_DEFAULT;
}

/**
 * True when the inbound owner message should use proactive resolve
 * (dedicated `proactive:resolve:<taskId>` session with Kanban context).
 */
export function shouldRouteOwnerReplyToProactiveResolve(
  state: ProactiveState,
  body: string,
  opts?: { nowMs?: number },
): boolean {
  if (parseProactiveTaskRef(body)) return true;
  if (!state.lastNudge) return false;
  if (state.feedbackPending) return true;

  const windowMs = resolveProactiveFollowUpWindowMs();
  if (windowMs === 0) return false;

  const nowMs = opts?.nowMs ?? Date.now();
  const anchor = state.lastOwnerReplyAt?.trim() || state.lastNudge.sentAt?.trim() || "";
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return false;
  return nowMs - anchorMs < windowMs;
}
