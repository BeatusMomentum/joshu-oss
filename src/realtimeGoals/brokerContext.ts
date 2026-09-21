import { formatSessionThreadForPrompt } from "./sessionThread.js";
import type { RealtimeGoalRecord, SessionThreadTurn } from "./types.js";

const HERMES_THREAD_TURNS = 4;

/** Compact broker snapshot for Hermes pass turns on queue-capable channels. */
export function buildHermesBrokerContextMessage(
  activeGoals: RealtimeGoalRecord[],
  threadTurns: SessionThreadTurn[],
  activeBranch?: RealtimeGoalRecord,
): string | undefined {
  if (activeGoals.length === 0 && threadTurns.length === 0 && !activeBranch) {
    return undefined;
  }

  const lines = [
    "Background work context (authoritative — do not contradict cancelled/queued state):",
  ];

  if (activeBranch) {
    lines.push(`Active branch: ${activeBranch.title} (${activeBranch.status})`);
  }

  if (activeGoals.length > 0) {
    lines.push("Active background goals:");
    for (const goal of activeGoals.slice(0, 6)) {
      lines.push(`- ${goal.title} (${goal.status})`);
    }
  } else {
    lines.push("Active background goals: (none)");
  }

  const recentThread = formatSessionThreadForPrompt(threadTurns, HERMES_THREAD_TURNS);
  if (recentThread !== "(empty)") {
    lines.push("", "Recent owner↔box thread:", recentThread);
  }

  return lines.join("\n");
}
