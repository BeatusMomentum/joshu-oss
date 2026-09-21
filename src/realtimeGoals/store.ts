import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  isRealtimeGoalActive,
  realtimeGoalSessionKey,
  type RealtimeGoalDeliveryKind,
  type RealtimeGoalInboxRecord,
  type RealtimeGoalRecord,
  type RealtimeGoalState,
} from "./types.js";

const DELIVERY_LEASE_MS = 2 * 60_000;

/** Hash kind+text so duplicate completion SMS can be suppressed idempotently. */
export function realtimeGoalDeliveryContentKey(
  kind: RealtimeGoalDeliveryKind,
  text: string,
): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 32);
}

const EMPTY_STATE: RealtimeGoalState = { version: 1, goals: [] };

function stateDirectory(projectRoot: string): string {
  const explicit = process.env.JOSHU_REALTIME_GOALS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const filesRoot = resolveJoshuFilesPaths(projectRoot)?.filesRoot;
  return filesRoot
    ? path.join(filesRoot, ".joshu", "realtime-goals")
    : path.join(projectRoot, ".local", "realtime-goals");
}

function normalizeState(value: unknown): RealtimeGoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_STATE };
  const parsed = value as Partial<RealtimeGoalState>;
  return {
    version: 1,
    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
  };
}

/**
 * Small, process-serialized JSON registry.
 *
 * Kanban owns execution state. This file owns intake, source idempotency, and
 * same-channel delivery cursors, and is persisted on the owner's Files volume.
 */
export class RealtimeGoalStore {
  private readonly dir: string;
  private readonly file: string;
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor(projectRoot: string) {
    this.dir = stateDirectory(projectRoot);
    this.file = path.join(this.dir, "state.json");
  }

  private async readUnlocked(): Promise<RealtimeGoalState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ...EMPTY_STATE, goals: [] };
      throw new Error(`realtime goal state read failed: ${(error as Error).message}`);
    }
  }

  private async writeUnlocked(state: RealtimeGoalState): Promise<void> {
    const inboxCutoff = Date.now() - 7 * 24 * 60 * 60_000;
    state.inbox = (state.inbox ?? []).filter(
      (item) =>
        (!item.processedAt && !item.recoveryNotifiedAt) ||
        Date.parse(item.receivedAt) >= inboxCutoff,
    );
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }

  async read(): Promise<RealtimeGoalState> {
    return this.transaction(async (state) => ({ result: structuredClone(state), changed: false }));
  }

  async transaction<T>(
    mutate: (state: RealtimeGoalState) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.transactionTail = this.transactionTail
      .catch(() => undefined)
      .then(async () => {
        try {
          const state = await this.readUnlocked();
          const next = await mutate(state);
          if (next.changed) await this.writeUnlocked(state);
          resolveResult(next.result);
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  async get(goalId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find((goal) => goal.id === goalId);
  }

  async findBySource(originKey: string, sourceMessageId: string): Promise<RealtimeGoalRecord | undefined> {
    const state = await this.read();
    return state.goals.find(
      (goal) =>
        realtimeGoalSessionKey(goal.origin) === originKey &&
        (goal.sourceMessageId === sourceMessageId ||
          goal.handledSourceIds?.includes(sourceMessageId)),
    );
  }

  async listActiveForSession(originKey: string): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals
      .filter(
        (goal) =>
          realtimeGoalSessionKey(goal.origin) === originKey && isRealtimeGoalActive(goal),
      )
      .sort((a, b) =>
        (b.ownerInteractedAt ?? b.createdAt).localeCompare(
          a.ownerInteractedAt ?? a.createdAt,
        ),
      );
  }

  /** Recent done/blocked goals that may reopen when the active pointer is stale. */
  async listContinuableForSession(
    originKey: string,
    ttlMs: number,
  ): Promise<RealtimeGoalRecord[]> {
    const cutoff = Date.now() - ttlMs;
    const state = await this.read();
    return state.goals
      .filter((goal) => realtimeGoalSessionKey(goal.origin) === originKey)
      .filter((goal) => goal.status === "done" || goal.status === "blocked")
      .filter((goal) => Date.parse(goal.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listOutstanding(): Promise<RealtimeGoalRecord[]> {
    const state = await this.read();
    return state.goals.filter(
      (goal) => {
        if (
          goal.status === "cancelled" &&
          !goal.kanbanTaskId &&
          goal.releaseAt &&
          Date.parse(goal.releaseAt) <= Date.now() &&
          !goal.cancellationReconciledAt
        ) {
          return true;
        }
        if (goal.status === "queued" || goal.status === "releasing" || goal.status === "cancelling") {
          return true;
        }
        if (!goal.kanbanTaskId || goal.status === "cancelled") return false;
        const taskTerminal = goal.status === "done" || goal.status === "failed";
        return !taskTerminal ||
          (goal.delivery.state !== "delivered" && goal.delivery.state !== "suppressed");
      },
    );
  }

  async insert(goal: RealtimeGoalRecord): Promise<RealtimeGoalRecord> {
    return this.transaction((state) => {
      const duplicate = state.goals.find(
        (item) =>
          realtimeGoalSessionKey(item.origin) === realtimeGoalSessionKey(goal.origin) &&
          item.sourceMessageId === goal.sourceMessageId,
      );
      if (duplicate) return { result: duplicate, changed: false };
      state.goals.push(goal);
      return { result: goal, changed: true };
    });
  }

  async update(
    goalId: string,
    mutate: (goal: RealtimeGoalRecord) => void,
  ): Promise<RealtimeGoalRecord | undefined> {
    return this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal) return { result: undefined, changed: false };
      mutate(goal);
      goal.updatedAt = new Date().toISOString();
      return { result: structuredClone(goal), changed: true };
    });
  }

  async reserveInbound(record: RealtimeGoalInboxRecord): Promise<void> {
    await this.transaction((state) => {
      state.inbox ??= [];
      if (state.inbox.some((item) => item.id === record.id)) {
        return { result: undefined, changed: false };
      }
      state.inbox.push(record);
      return { result: undefined, changed: true };
    });
  }

  async completeInbound(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.processedAt) return { result: undefined, changed: false };
      item.processedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  async listStaleInbound(minAgeMs: number): Promise<RealtimeGoalInboxRecord[]> {
    const state = await this.read();
    const cutoff = Date.now() - minAgeMs;
    return (state.inbox ?? []).filter(
      (item) =>
        !item.processedAt &&
        !item.recoveryNotifiedAt &&
        Date.parse(item.receivedAt) <= cutoff,
    );
  }

  async markInboundRecoveryNotified(id: string): Promise<void> {
    await this.transaction((state) => {
      const item = state.inbox?.find((candidate) => candidate.id === id);
      if (!item || item.recoveryNotifiedAt) return { result: undefined, changed: false };
      item.recoveryNotifiedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }

  /**
   * Atomically claim one delivery attempt. Prevents concurrent duplicate SMS when
   * lifecycle ticks overlap or completion is reconciled twice.
   */
  async claimDeliveryAttempt(
    goalId: string,
    kind: RealtimeGoalDeliveryKind,
    text: string,
    maxAttempts: number,
  ): Promise<{ claimed: boolean; goal?: RealtimeGoalRecord; contentKey: string }> {
    const contentKey = realtimeGoalDeliveryContentKey(kind, text);
    type ClaimResult = { claimed: boolean; goal?: RealtimeGoalRecord; contentKey: string };
    return this.transaction<ClaimResult>((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal || goal.status === "cancelled" || goal.delivery.state === "suppressed") {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      if (goal.delivery.attempts >= maxAttempts) {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      if (
        goal.delivery.nextAttemptAt &&
        Date.parse(goal.delivery.nextAttemptAt) > Date.now()
      ) {
        return { result: { claimed: false, contentKey }, changed: false };
      }
      if (kind !== "blocked") {
        if (goal.delivery.state === "delivered") {
          return { result: { claimed: false, contentKey }, changed: false };
        }
        if (goal.delivery.lastDeliveredKey === contentKey) {
          return { result: { claimed: false, contentKey }, changed: false };
        }
      }
      if (goal.delivery.state === "attempting") {
        const leaseUntil = Date.parse(goal.delivery.attemptLeaseUntil ?? "");
        if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
          return { result: { claimed: false, contentKey }, changed: false };
        }
        goal.delivery.lastError = "stale delivery attempt recovered after restart";
      }
      goal.delivery.state = "attempting";
      goal.delivery.attempts += 1;
      goal.delivery.lastAttemptAt = new Date().toISOString();
      goal.delivery.attemptLeaseUntil = new Date(Date.now() + DELIVERY_LEASE_MS).toISOString();
      goal.updatedAt = new Date().toISOString();
      return {
        result: { claimed: true, goal: structuredClone(goal), contentKey },
        changed: true,
      };
    });
  }

  async finalizeDeliveryAttempt(
    goalId: string,
    contentKey: string,
    result: {
      delivered: boolean;
      pending?: boolean;
      providerId?: string;
      error?: string;
      retryAt?: string;
    },
    maxAttempts: number,
  ): Promise<void> {
    await this.transaction((state) => {
      const goal = state.goals.find((item) => item.id === goalId);
      if (!goal) return { result: undefined, changed: false };
      if (result.delivered) {
        goal.delivery.state = "delivered";
        goal.delivery.deliveredAt = new Date().toISOString();
        goal.delivery.lastDeliveredKey = contentKey;
        goal.delivery.providerId = result.providerId;
        goal.delivery.nextAttemptAt = undefined;
        goal.delivery.attemptLeaseUntil = undefined;
        goal.delivery.lastError = undefined;
      } else if (result.pending && result.providerId) {
        goal.delivery.state = "attempting";
        goal.delivery.providerId = result.providerId;
        goal.delivery.lastError = result.error;
        goal.delivery.nextAttemptAt = undefined;
        goal.delivery.attemptLeaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
      } else {
        goal.delivery.state = "pending";
        goal.delivery.lastError = result.error || "delivery failed";
        const waitMs = Math.min(
          15 * 60_000,
          15_000 * 2 ** Math.max(0, goal.delivery.attempts - 1),
        );
        goal.delivery.nextAttemptAt =
          result.retryAt ?? new Date(Date.now() + waitMs).toISOString();
        goal.delivery.attemptLeaseUntil = undefined;
      }
      if (goal.delivery.attempts >= maxAttempts && goal.delivery.state !== "delivered") {
        goal.delivery.lastError ??= "delivery attempts exhausted";
      }
      goal.updatedAt = new Date().toISOString();
      return { result: undefined, changed: true };
    });
  }
}
