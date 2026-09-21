import type { RealtimeGoalRecord } from "./types.js";
import { isRealtimeGoalActive } from "./types.js";

/** Align with session thread TTL — continuable done/blocked goals may reopen via pointer. */
export const CONTINUABLE_GOAL_MS = 48 * 60 * 60_000;

export function isContinuableGoal(
  goal: RealtimeGoalRecord,
  pointerSetAt?: string,
): boolean {
  if (isRealtimeGoalActive(goal)) return true;
  if (goal.status !== "done" && goal.status !== "blocked") return false;
  const anchor = pointerSetAt ?? goal.updatedAt;
  const age = Date.now() - Date.parse(anchor);
  return Number.isFinite(age) && age >= 0 && age <= CONTINUABLE_GOAL_MS;
}
