import { readProactiveState, writeProactiveState } from "./state.js";
import type { ClarifyQueueItem, ProactiveCandidate, ProactiveState } from "./types.js";

export type EnqueueClarifyInput = {
  taskId: string;
  board: string;
  title: string;
  blockReason: string | null;
  conflict: string;
  handoffAt?: string | null;
};

/** Queue a model-conflict clarification for the next proactive tick. */
export function enqueueClarifyCandidate(
  projectRoot: string,
  input: EnqueueClarifyInput,
): ProactiveState {
  const state = readProactiveState(projectRoot);
  const taskId = input.taskId.trim();
  const now = new Date().toISOString();
  const item: ClarifyQueueItem = {
    taskId,
    board: input.board.trim(),
    title: input.title.trim() || "(untitled)",
    blockReason: input.blockReason ?? null,
    conflict: input.conflict.trim(),
    handoffAt: input.handoffAt?.trim() || null,
    queuedAt: now,
  };

  const map = new Map((state.clarifyQueue ?? []).map((q) => [q.taskId, q] as const));
  const existing = map.get(taskId);
  if (existing) {
    map.set(taskId, {
      ...existing,
      ...item,
      queuedAt: existing.queuedAt,
    });
  } else {
    map.set(taskId, item);
  }

  const next: ProactiveState = {
    ...state,
    clarifyQueue: [...map.values()],
  };
  writeProactiveState(next, projectRoot);
  return next;
}

export function isTaskInClarifyQueue(state: ProactiveState, taskId: string): boolean {
  return (state.clarifyQueue ?? []).some((q) => q.taskId === taskId.trim());
}

/** Highest-priority clarify item not nudged today. */
export function pickTopClarifyCandidate(
  state: ProactiveState,
): ClarifyQueueItem | null {
  for (const item of state.clarifyQueue ?? []) {
    if (state.nudgedTaskIds.includes(item.taskId)) continue;
    return item;
  }
  return null;
}

export function clarifyToCandidate(item: ClarifyQueueItem): ProactiveCandidate {
  return {
    taskId: item.taskId,
    board: item.board,
    title: item.title,
    status: "blocked",
    blockReason: item.blockReason,
    body: item.conflict,
    rankScore: 100,
    rankSignals: {},
  };
}

/** Remove clarify queue entry after owner reply or auto-resolve. */
export function removeClarifyCandidate(
  projectRoot: string,
  taskId: string,
): ProactiveState {
  const state = readProactiveState(projectRoot);
  const id = taskId.trim();
  const next: ProactiveState = {
    ...state,
    clarifyQueue: (state.clarifyQueue ?? []).filter((q) => q.taskId !== id),
  };
  writeProactiveState(next, projectRoot);
  return next;
}
