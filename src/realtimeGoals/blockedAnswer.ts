import type { RealtimeGoalRecord } from "./types.js";

/** Normalize owner pick text for storage and kanban directives. */
export function normalizeOwnerSelection(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * After the owner answers a blocked prompt, suppress re-SMS of the same
 * hotel-menu question when the worker kanban_blocks again with a repeat reason.
 */
export function shouldSuppressRepeatBlockedPrompt(
  goal: Pick<RealtimeGoalRecord, "blockedAnsweredAt" | "lastBlockedPrompt">,
  reason: string,
): boolean {
  if (!goal.blockedAnsweredAt) return false;
  const trimmed = reason.trim();
  const lower = trimmed.toLowerCase();
  // Common hotel-menu block after owner already picked from the list.
  if (lower.includes("which one do you want")) return true;
  const prev = goal.lastBlockedPrompt?.trim();
  if (!prev) return false;
  if (trimmed === prev) return true;
  const prevPrefix = prev.slice(0, 80).toLowerCase();
  const curPrefix = trimmed.slice(0, 80).toLowerCase();
  return Boolean(prevPrefix && prevPrefix === curPrefix);
}

/** Loud kanban append when owner picks from a blocked comparison list. */
export function ownerSelectionKanbanAppend(
  text: string,
  at: string,
  sourceId: string,
): string {
  const choice = normalizeOwnerSelection(text);
  return [
    `\n## Owner selection (${at}) — BOOK THIS (do not re-search)`,
    `Realtime-Source: ${sourceId}`,
    `Owner chose: ${choice}`,
    "",
    "Treat this as authorization to book/hold the chosen property for the dates on this card.",
    "Do NOT run a new broad OTA hotel search or re-send a multi-hotel comparison list.",
    "Go directly to checkout on the chosen property (direct hotel site or the property URL from prior research).",
    "If checkout is staged with a handoff link, call kanban_complete with the link and what the owner must enter.",
    "Only call kanban_block if that specific property is unavailable — ask a NEW question, not the old menu.",
  ].join("\n");
}

/** Generic owner update append for non-blocked mid-task amendments. */
export function ownerUpdateKanbanAppend(
  text: string,
  at: string,
  sourceId: string,
): string {
  return `\n## Owner update (${at})\nRealtime-Source: ${sourceId}\n${text}`;
}
