import { createHash, randomUUID } from "node:crypto";

import {
  callKanbanBridge,
  eaKanbanCreateDefaults,
  eaSchedulingKanbanAssignee,
  ensureRealtimeGoalsBoard,
  REALTIME_GOALS_KANBAN_BOARD,
} from "../hermesKanbanBridge.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import {
  normalizeOwnerSelection,
  ownerSelectionKanbanAppend,
  ownerUpdateKanbanAppend,
  shouldSuppressRepeatBlockedPrompt,
} from "./blockedAnswer.js";
import { isContinuableGoal } from "./branchBinding.js";
import { buildHermesBrokerContextMessage } from "./brokerContext.js";
import { isDeferCapableChannel, isQueueCapableChannel, usesSessionThread } from "./channelPolicy.js";
import {
  isExplicitCancelPhrase,
  routeRealtimeGoalMessage,
  type RouteRealtimeGoalMessageInput,
  type RouteRealtimeGoalMessageOptions,
  type RealtimeGoalRouteDecision,
} from "./router.js";
import { SessionThreadStore } from "./sessionThread.js";
import { RealtimeGoalStore } from "./store.js";
import {
  realtimeGoalSessionKey,
  type RealtimeGoalDeliveryHandler,
  type RealtimeGoalOrigin,
  type RealtimeGoalInboxRecord,
  type RealtimeGoalRecord,
  type RealtimeGoalRouteInput,
  type RealtimeGoalRouteResult,
  type RealtimeGoalSurfaceEvent,
} from "./types.js";

const DEFAULT_RELEASE_DELAY_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 5;

function isoNow(): string {
  return new Date().toISOString();
}

function releaseDelayMs(): number {
  const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_RELEASE_SECONDS ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RELEASE_DELAY_MS / 1000;
  return seconds * 1000;
}

function shortTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "Owner request";
  return firstLine.replace(/\s+/g, " ").slice(0, 100) || "Owner request";
}

function sourceMessageId(origin: RealtimeGoalOrigin): string {
  return origin.messageId?.trim() || randomUUID();
}

function idempotencyKey(origin: RealtimeGoalOrigin, sourceId: string): string {
  const digest = createHash("sha256")
    .update(`${realtimeGoalSessionKey(origin)}\n${sourceId}`)
    .digest("hex")
    .slice(0, 32);
  return `realtime-goal:v1:${digest}`;
}

function queuedReply(): string {
  return "This will take a little longer, so I queued it. I'll reply here when it's done. Anything else?";
}

function statusReply(goal: RealtimeGoalRecord): string {
  if (goal.status === "clarifying") return `I'm waiting on one detail for “${goal.title}.”`;
  if (goal.status === "queued" || goal.status === "releasing") {
    return `“${goal.title}” is queued and will start shortly.`;
  }
  if (goal.status === "blocked") {
    return goal.lastBlockReason
      ? `“${goal.title}” is waiting on: ${goal.lastBlockReason}`
      : `“${goal.title}” is waiting for input.`;
  }
  if (goal.status === "done") return `“${goal.title}” is done.`;
  if (goal.status === "cancelled") return `“${goal.title}” was cancelled.`;
  return `“${goal.title}” is ${goal.status}.`;
}

function markSourceHandled(
  goal: RealtimeGoalRecord,
  sourceId: string,
  reply: string,
  outcome: "clarify" | "queued" | "updated" | "cancelled" | "status" | "ack",
): void {
  goal.handledSourceIds ??= [goal.sourceMessageId];
  if (!goal.handledSourceIds.includes(sourceId)) {
    goal.handledSourceIds.push(sourceId);
    goal.sourceReceipts ??= [];
    goal.sourceReceipts.push({ sourceId, reply, outcome, at: isoNow() });
  }
  goal.intakeReply = reply;
  goal.ownerInteractedAt = isoNow();
}

function taskBody(goal: RealtimeGoalRecord): string {
  const ownerMessages = goal.messages
    .filter((message) => message.role === "owner")
    .map((message, index) => `${index === 0 ? "Original request" : `Update ${index}`} (${message.at}):\n${message.text}`)
    .join("\n\n");
  return [
    "# Realtime owner goal",
    "",
    `Goal ID: ${goal.id}`,
    `Origin channel: ${goal.origin.channel}`,
    "",
    "## Completion contract",
    "",
    `Objective: ${goal.objective}`,
    "",
    "Complete the owner's request safely. Use reasonable defaults for low-risk details.",
    "Before consequential external writes, follow the normal action guard.",
    "Re-read this task and recent comments before consequential actions and before completion.",
    "If the card body contains an Owner selection — BOOK THIS section, the search phase is over: book that choice only.",
    "If required owner input is missing, call kanban_block with one concise question.",
    "When checkout is staged with a browser handoff link, call kanban_complete with the link — do not kanban_block with an old menu.",
    "On success, call kanban_complete with a self-contained plain-language summary and any artifacts.",
    "",
    "## Intake",
    "",
    ownerMessages,
  ].join("\n");
}

export class RealtimeGoalBroker {
  readonly store: RealtimeGoalStore;
  readonly threads: SessionThreadStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickRunning = false;
  private boardReady = false;

  constructor(
    private readonly projectRoot: string,
    private readonly deliver: RealtimeGoalDeliveryHandler,
    private readonly routeMessage: (
      input: RouteRealtimeGoalMessageInput,
      options?: RouteRealtimeGoalMessageOptions,
    ) => Promise<RealtimeGoalRouteDecision> = routeRealtimeGoalMessage,
  ) {
    this.store = new RealtimeGoalStore(projectRoot);
    this.threads = new SessionThreadStore(projectRoot);
  }

  private threadKey(origin: RealtimeGoalOrigin): string {
    return origin.sessionKey.trim();
  }

  async recordOwnerTurn(origin: RealtimeGoalOrigin, text: string): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.recordOwnerTurn(
      this.threadKey(origin),
      text,
      origin.messageId,
    );
  }

  async recordBoxTurn(
    origin: RealtimeGoalOrigin,
    text: string,
    source: "broker" | "delivery" | "hermes",
    goalId?: string,
  ): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.recordBoxTurn(this.threadKey(origin), text, source, goalId);
  }

  /** Compact broker snapshot for Hermes pass turns on queue-capable channels. */
  async buildHermesContextSnapshot(origin: RealtimeGoalOrigin): Promise<string | undefined> {
    if (!isQueueCapableChannel(origin.channel)) return undefined;
    const session = realtimeGoalSessionKey(origin);
    const active = await this.store.listActiveForSession(session);
    const threadTurns = await this.threads.getTurns(this.threadKey(origin));
    const activeBranch = await this.resolveActiveGoal(session, this.threadKey(origin));
    return buildHermesBrokerContextMessage(active, threadTurns, activeBranch);
  }

  start(): void {
    if (this.timer) return;
    const raw = Number.parseInt(process.env.JOSHU_REALTIME_GOALS_POLL_MS ?? "", 10);
    const interval = Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_POLL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async route(input: RealtimeGoalRouteInput): Promise<RealtimeGoalRouteResult> {
    const text = input.text.trim();
    if (!text) return { action: "pass" };

    if (!isQueueCapableChannel(input.origin.channel)) {
      await this.recordOwnerTurn(input.origin, text);
      return { action: "pass" };
    }

    const session = realtimeGoalSessionKey(input.origin);
    const src = sourceMessageId(input.origin);
    await this.recordOwnerTurn(input.origin, text);
    const threadTurns = await this.threads.getTurns(this.threadKey(input.origin));

    const duplicate = await this.store.findBySource(session, src);
    if (duplicate) {
      const receipt = duplicate.sourceReceipts?.find((item) => item.sourceId === src);
      const replyText = receipt?.reply ?? duplicate.intakeReply;
      await this.recordBoxTurn(input.origin, replyText, "broker", duplicate.id);
      return {
        action: "reply",
        text: replyText,
        goalId: duplicate.id,
        outcome:
          receipt?.outcome ??
          (duplicate.status === "clarifying"
            ? "clarify"
            : duplicate.status === "cancelled"
              ? "cancelled"
              : "queued"),
      };
    }

    const active = await this.store.listActiveForSession(session);
    if (active.length > 1 && isExplicitCancelPhrase(text)) {
      const choices = active
        .slice(0, 4)
        .map((goal, index) => `${index + 1}) ${goal.title}`)
        .join("; ");
      const replyText = `Which queued job should I cancel? ${choices}. Say “cancel” and the title.`;
      await this.recordBoxTurn(input.origin, replyText, "broker");
      return {
        action: "reply",
        text: replyText,
        outcome: "status",
      };
    }

    const threadKey = this.threadKey(input.origin);
    const activeBranch = await this.resolveActiveGoal(session, threadKey);
    const queueCapable = isQueueCapableChannel(input.origin.channel);

    const admission = activeBranch
      ? await this.routeMessage({
          text,
          activeGoals: active,
          threadTurns,
          queueCapable,
          activeBranch,
        })
      : await this.routeMessage({
          text,
          activeGoals: active,
          threadTurns,
          queueCapable,
        });
    console.info(
      `[realtime-goals] decision=${admission.decision} confidence=${admission.confidence.toFixed(2)} channel=${input.origin.channel} bound=${Boolean(activeBranch)} reason=${admission.reason}`,
    );

    if (activeBranch && admission.decision === "update") {
      const continuation = await this.handleBranchContinuation(
        activeBranch,
        text,
        src,
        input.origin,
      );
      if (continuation) {
        await this.setActiveGoalPointer(input.origin, activeBranch.id);
        return continuation;
      }
    }

    if (activeBranch && admission.decision === "queue") {
      await this.clearActiveGoalPointer(input.origin);
    }

    if (admission.decision === "pass") return { action: "pass" };

    if (admission.decision === "ack" && admission.reply) {
      const anchor = admission.goalId
        ? active.find((goal) => goal.id === admission.goalId)
        : active[0];
      if (anchor) {
        await this.store.update(anchor.id, (goal) =>
          markSourceHandled(goal, src, admission.reply!, "ack"),
        );
      }
      await this.recordBoxTurn(input.origin, admission.reply, "broker", anchor?.id);
      return {
        action: "reply",
        text: admission.reply,
        goalId: anchor?.id,
        outcome: "ack",
      };
    }

    if (admission.decision === "cancel" && admission.goalId) {
      const cancelled = await this.cancel(admission.goalId, text);
      if (!cancelled) return { action: "pass" };
      const reply =
        cancelled.status === "cancelled"
          ? `Cancelled “${cancelled.title}.”`
          : `I'm still stopping “${cancelled.title}.” I won't deliver a completion while cancellation is pending.`;
      await this.store.update(cancelled.id, (goal) =>
        markSourceHandled(goal, src, reply, "cancelled"),
      );
      await this.recordBoxTurn(input.origin, reply, "broker", cancelled.id);
      return {
        action: "reply",
        text: reply,
        goalId: cancelled.id,
        outcome: "cancelled",
      };
    }

    const target = admission.goalId
      ? active.find((goal) => goal.id === admission.goalId)
      : undefined;

    if (admission.decision === "status" && target) {
      const reply = statusReply(target);
      await this.store.update(target.id, (goal) =>
        markSourceHandled(goal, src, reply, "status"),
      );
      await this.recordBoxTurn(input.origin, reply, "broker", target.id);
      return {
        action: "reply",
        text: reply,
        goalId: target.id,
        outcome: "status",
      };
    }

    if (admission.decision === "update" && target) {
      const updated =
        target.status === "blocked"
          ? (await this.answerBlockedGoal(target.id, text, src)) ?? target
          : await this.appendOwnerUpdate(target, text, src);
      await this.recordBoxTurn(input.origin, updated.intakeReply, "broker", updated.id);
      return {
        action: "reply",
        text: updated.intakeReply,
        goalId: updated.id,
        outcome: "updated",
      };
    }

    if (admission.decision === "queue" && target?.status === "clarifying") {
      const queued = await this.store.update(target.id, (goal) => {
        if (goal.handledSourceIds?.includes(src)) return;
        goal.status = "queued";
        goal.objective = `${goal.objective}\n\nClarification: ${text}`;
        goal.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
        goal.clarificationQuestion = undefined;
        goal.messages.push({ at: isoNow(), role: "owner", text });
        markSourceHandled(goal, src, queuedReply(), "queued");
      });
      if (queued) {
        await this.recordBoxTurn(input.origin, queued.intakeReply, "broker", queued.id);
        return {
          action: "reply",
          text: queued.intakeReply,
          goalId: queued.id,
          outcome: "queued",
        };
      }
    }

    if (admission.decision === "clarify" && admission.question) {
      const reply = admission.question;
      if (target?.status === "clarifying") {
        const updated = await this.store.update(target.id, (goal) => {
          if (goal.handledSourceIds?.includes(src)) return;
          goal.objective = `${goal.objective}\n\nClarification answer: ${text}`;
          goal.messages.push({ at: isoNow(), role: "owner", text });
          goal.messages.push({ at: isoNow(), role: "broker", text: reply });
          goal.clarificationQuestion = reply;
          markSourceHandled(goal, src, reply, "clarify");
        });
        if (updated) {
          await this.recordBoxTurn(input.origin, reply, "broker", updated.id);
          return {
            action: "reply",
            text: reply,
            goalId: updated.id,
            outcome: "clarify",
          };
        }
      }
      const goal = await this.createGoal({
        origin: { ...input.origin, messageId: src },
        text,
        title: admission.title,
        status: "clarifying",
        intakeReply: reply,
        clarificationQuestion: reply,
      });
      await this.recordBoxTurn(input.origin, reply, "broker", goal.id);
      return { action: "reply", text: reply, goalId: goal.id, outcome: "clarify" };
    }

    if (admission.decision === "queue") {
      const goal = await this.createGoal({
        origin: { ...input.origin, messageId: src },
        text,
        title: admission.title,
        status: "queued",
        intakeReply: queuedReply(),
      });
      await this.recordBoxTurn(input.origin, goal.intakeReply, "broker", goal.id);
      return {
        action: "reply",
        text: goal.intakeReply,
        goalId: goal.id,
        outcome: "queued",
      };
    }

    return { action: "pass" };
  }

  async reserveInbound(input: RealtimeGoalRouteInput): Promise<string> {
    const messageId = input.origin.messageId?.trim();
    if (!messageId) throw new Error("durable inbound reservation requires messageId");
    const id = `${input.origin.channel}:${messageId}`;
    const record: RealtimeGoalInboxRecord = {
      id,
      origin: input.origin,
      text: input.text.slice(0, 4_000),
      receivedAt: isoNow(),
    };
    await this.store.reserveInbound(record);
    return id;
  }

  async completeInbound(id: string): Promise<void> {
    await this.store.completeInbound(id);
  }

  /** Agent-callable fallback when a normal Hermes turn discovers the work is long. */
  async defer(input: RealtimeGoalRouteInput, title?: string): Promise<RealtimeGoalRecord> {
    if (!isDeferCapableChannel(input.origin.channel)) {
      throw new Error(`realtime_goal_defer is unavailable on channel ${input.origin.channel}`);
    }
    const src = sourceMessageId(input.origin);
    const session = realtimeGoalSessionKey(input.origin);
    const duplicate = await this.store.findBySource(session, src);
    if (duplicate) return duplicate;
    await this.recordOwnerTurn(input.origin, input.text);
    const goal = await this.createGoal({
      origin: { ...input.origin, messageId: src },
      text: input.text,
      title,
      status: "queued",
      intakeReply: queuedReply(),
    });
    await this.recordBoxTurn(input.origin, goal.intakeReply, "broker", goal.id);
    return goal;
  }

  async cancel(goalId: string, reason = "Owner cancelled"): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.update(goalId, (item) => {
      item.status = item.kanbanTaskId ? "cancelling" : "cancelled";
      if (!item.kanbanTaskId) item.cancelledAt = isoNow();
      item.cancelReason = reason.slice(0, 500);
      item.delivery.state = "suppressed";
      item.intakeReply = item.kanbanTaskId
        ? `I'm stopping “${item.title}.”`
        : `Cancelled “${item.title}.”`;
    });
    if (!goal?.kanbanTaskId) {
      if (goal?.status === "cancelled") {
        await this.clearActiveGoalPointer(goal.origin);
      }
      return goal;
    }
    const cancelled = await this.retryCancellation(goal.id);
    if (cancelled?.status === "cancelled") {
      await this.clearActiveGoalPointer(cancelled.origin);
    }
    return cancelled;
  }

  private async retryCancellation(goalId: string): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.get(goalId);
    if (!goal) return undefined;
    if (!goal.kanbanTaskId) {
      return this.store.update(goalId, (item) => {
        item.status = "cancelled";
        item.cancelledAt ??= isoNow();
      });
    }
    const result = await callKanbanBridge({
      action: "cancel",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
      reason: goal.cancelReason || "Owner cancelled",
    }).catch((error) => ({ success: false, error: (error as Error).message }));
    if (!result.success) {
      console.warn(
        `[realtime-goals] cancel task=${goal.kanbanTaskId} pending retry: ${result.error}`,
      );
      return this.store.update(goalId, (item) => {
        item.status = "cancelling";
      });
    }
    return this.store.update(goalId, (item) => {
      item.status = "cancelled";
      item.cancelledAt = isoNow();
      item.delivery.state = "suppressed";
      item.intakeReply = `Cancelled “${item.title}.”`;
    });
  }

  async recordVoiceCallbackStatus(
    goalId: string,
    status: string,
    callSid: string,
  ): Promise<void> {
    const normalized = status.trim().toLowerCase();
    await this.store.update(goalId, (goal) => {
      if (callSid && goal.delivery.providerId && goal.delivery.providerId !== callSid) return;
      if (["busy", "failed", "no-answer", "canceled"].includes(normalized)) {
        goal.delivery.state = "pending";
        goal.delivery.lastError = `Twilio call ${normalized}`;
        goal.delivery.nextAttemptAt = new Date(Date.now() + 15 * 60_000).toISOString();
        goal.delivery.attemptLeaseUntil = undefined;
      }
      // "completed" is not proof the passphrase succeeded. The authenticated
      // result endpoint marks delivery when voice-realtime actually fetches it.
      if (normalized === "completed" && goal.delivery.state !== "delivered") {
        goal.delivery.state = "pending";
        goal.delivery.lastError = "Callback ended before authenticated delivery";
        goal.delivery.nextAttemptAt = new Date(Date.now() + 15 * 60_000).toISOString();
        goal.delivery.attemptLeaseUntil = undefined;
      }
    });
  }

  async markVoiceDelivered(goalId: string): Promise<void> {
    await this.store.update(goalId, (goal) => {
      goal.delivery.state = "delivered";
      goal.delivery.deliveredAt = isoNow();
      goal.delivery.nextAttemptAt = undefined;
      goal.delivery.attemptLeaseUntil = undefined;
      goal.delivery.lastError = undefined;
    });
  }

  async answerBlockedGoal(
    goalId: string,
    text: string,
    sourceId: string,
  ): Promise<RealtimeGoalRecord | undefined> {
    const goal = await this.store.get(goalId);
    if (!goal) return undefined;
    const receipt = goal.sourceReceipts?.find((item) => item.sourceId === sourceId);
    if (receipt) return { ...goal, intakeReply: receipt.reply };
    if (goal.status !== "blocked") return undefined;
    return this.appendOwnerUpdate(goal, text, sourceId);
  }

  async listSurfaceEvents(sessionKey: string): Promise<RealtimeGoalSurfaceEvent[]> {
    const state = await this.store.read();
    return state.goals
      .filter((goal) => goal.origin.sessionKey === sessionKey)
      .flatMap((goal) => goal.surfaceEvents ?? [])
      .filter((event) => !event.consumedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async consumeSurfaceEvent(sessionKey: string, eventId: string): Promise<boolean> {
    const state = await this.store.read();
    const goal = state.goals.find(
      (item) =>
        item.origin.sessionKey === sessionKey &&
        item.surfaceEvents?.some((event) => event.id === eventId && !event.consumedAt),
    );
    if (!goal) return false;
    await this.store.update(goal.id, (item) => {
      const event = item.surfaceEvents?.find((candidate) => candidate.id === eventId);
      if (event && !event.consumedAt) event.consumedAt = isoNow();
    });
    return true;
  }

  private async setActiveGoalPointer(
    origin: RealtimeGoalOrigin,
    goalId: string,
  ): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.setActiveGoal(this.threadKey(origin), goalId);
  }

  private async clearActiveGoalPointer(origin: RealtimeGoalOrigin): Promise<void> {
    if (!usesSessionThread(origin.channel)) return;
    await this.threads.clearActiveGoal(this.threadKey(origin));
  }

  /** Resolve the open branch on this trunk via activeGoalId only (no silent re-bind). */
  private async resolveActiveGoal(
    session: string,
    threadKey: string,
  ): Promise<RealtimeGoalRecord | undefined> {
    const pointer = await this.threads.getActiveGoal(threadKey);
    if (!pointer) return undefined;

    const goal = await this.store.get(pointer.goalId);
    if (goal && realtimeGoalSessionKey(goal.origin) === session) {
      if (isContinuableGoal(goal, pointer.setAt)) {
        return goal;
      }
    }
    await this.threads.clearActiveGoal(threadKey);
    return undefined;
  }

  private async handleBranchContinuation(
    goal: RealtimeGoalRecord,
    text: string,
    sourceId: string,
    origin: RealtimeGoalOrigin,
  ): Promise<RealtimeGoalRouteResult | undefined> {
    if (goal.status === "cancelled" || goal.status === "failed") {
      await this.clearActiveGoalPointer(origin);
      return undefined;
    }

    if (goal.status === "done") {
      return this.reopenContinuableGoal(goal, text, sourceId, origin);
    }

    const updated =
      goal.status === "blocked"
        ? (await this.answerBlockedGoal(goal.id, text, sourceId)) ?? goal
        : await this.appendOwnerUpdate(goal, text, sourceId);

    await this.recordBoxTurn(origin, updated.intakeReply, "broker", updated.id);
    return {
      action: "reply",
      text: updated.intakeReply,
      goalId: updated.id,
      outcome:
        updated.status === "queued" && goal.status === "clarifying" ? "queued" : "updated",
    };
  }

  private async reopenContinuableGoal(
    goal: RealtimeGoalRecord,
    text: string,
    sourceId: string,
    origin: RealtimeGoalOrigin,
  ): Promise<RealtimeGoalRouteResult | undefined> {
    if (!isContinuableGoal(goal)) {
      await this.clearActiveGoalPointer(origin);
      return undefined;
    }

    const reply = this.ownerUpdateReply(goal, text, false, false);
    let applied = false;
    const updated = await this.store.update(goal.id, (item) => {
      if (item.handledSourceIds?.includes(sourceId)) return;
      applied = true;
      item.messages.push({ at: isoNow(), role: "owner", text });
      item.objective = `${item.objective}\n\nOwner update: ${text}`;
      item.status = item.kanbanTaskId ? "ready" : "queued";
      if (!item.kanbanTaskId) {
        item.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
      }
      markSourceHandled(item, sourceId, reply, "updated");
      if (item.kanbanTaskId) {
        item.pendingOwnerUpdates ??= [];
        item.pendingOwnerUpdates.push({
          sourceId,
          text,
          at: isoNow(),
          fromBlockedAnswer: false,
        });
      }
    });
    if (!updated) return undefined;

    const receipt = updated.sourceReceipts?.find((item) => item.sourceId === sourceId);
    const replyText = receipt?.reply ?? updated.intakeReply;

    if (applied && updated.kanbanTaskId) {
      await callKanbanBridge({
        action: "reopen",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: updated.kanbanTaskId,
      }).catch((error) => {
        console.warn(
          `[realtime-goals] reopen task=${updated.kanbanTaskId} failed: ${(error as Error).message}`,
        );
      });
      const flushed = await this.flushOwnerUpdates(updated.id).catch(() => false);
      if (!flushed) {
        const fallback = await this.store.update(updated.id, (item) => {
          item.intakeReply =
            `I saved that update for “${item.title}” and will keep retrying the worker handoff.`;
          const itemReceipt = item.sourceReceipts?.find((entry) => entry.sourceId === sourceId);
          if (itemReceipt) itemReceipt.reply = item.intakeReply;
        });
        if (fallback) {
          await this.recordBoxTurn(origin, fallback.intakeReply, "broker", fallback.id);
          return {
            action: "reply",
            text: fallback.intakeReply,
            goalId: fallback.id,
            outcome: "updated",
          };
        }
      }
    }

    const finalGoal = (await this.store.get(updated.id)) ?? updated;
    await this.recordBoxTurn(origin, replyText, "broker", finalGoal.id);
    return {
      action: "reply",
      text: replyText,
      goalId: finalGoal.id,
      outcome: "updated",
    };
  }

  private async createGoal(input: {
    origin: RealtimeGoalOrigin;
    text: string;
    title?: string;
    status: "clarifying" | "queued";
    intakeReply: string;
    clarificationQuestion?: string;
  }): Promise<RealtimeGoalRecord> {
    const now = isoNow();
    const src = sourceMessageId(input.origin);
    const goal: RealtimeGoalRecord = {
      id: randomUUID(),
      version: 1,
      title: input.title?.trim().slice(0, 120) || shortTitle(input.text),
      objective: input.text,
      status: input.status,
      origin: { ...input.origin, messageId: src },
      sourceMessageId: src,
      handledSourceIds: [src],
      idempotencyKey: idempotencyKey(input.origin, src),
      createdAt: now,
      updatedAt: now,
      ownerInteractedAt: now,
      ...(input.status === "queued"
        ? { releaseAt: new Date(Date.now() + releaseDelayMs()).toISOString() }
        : {}),
      ...(input.clarificationQuestion
        ? { clarificationQuestion: input.clarificationQuestion }
        : {}),
      messages: [{ at: now, role: "owner", text: input.text }],
      intakeReply: input.intakeReply,
      sourceReceipts: [
        {
          sourceId: src,
          reply: input.intakeReply,
          outcome: input.status === "clarifying" ? "clarify" : "queued",
          at: now,
        },
      ],
      delivery: { state: "pending", attempts: 0 },
    };
    const inserted = await this.store.insert(goal);
    await this.setActiveGoalPointer(input.origin, inserted.id);
    return inserted;
  }

  private ownerUpdateReply(
    target: RealtimeGoalRecord,
    text: string,
    wasBlocked: boolean,
    wasClarifying: boolean,
  ): string {
    const choice = text.trim().replace(/\s+/g, " ").slice(0, 80);
    if (wasBlocked) {
      return choice
        ? `Got it — continuing with “${choice}.” Please wait a moment while I finish the booking.`
        : `Got it — I have your answer and I'm continuing the booking now. Please wait a moment.`;
    }
    // Clarifying goals have no Kanban worker yet — be honest that work is queued.
    if (wasClarifying) {
      return queuedReply();
    }
    if (target.status === "running") {
      return `Got it — noted for “${target.title}.” I'm still on it and will work that in.`;
    }
    return `Got it — I added that to “${target.title}.” Please wait a moment while I work on it.`;
  }

  private async appendOwnerUpdate(
    target: RealtimeGoalRecord,
    text: string,
    sourceId: string,
  ): Promise<RealtimeGoalRecord> {
    const wasBlocked = target.status === "blocked";
    const wasClarifying = target.status === "clarifying";
    const reply = this.ownerUpdateReply(target, text, wasBlocked, wasClarifying);
    let applied = false;
    const updated = await this.store.update(target.id, (goal) => {
      if (goal.handledSourceIds?.includes(sourceId)) return;
      applied = true;
      goal.messages.push({ at: isoNow(), role: "owner", text });
      goal.objective = `${goal.objective}\n\nOwner update: ${text}`;
      markSourceHandled(
        goal,
        sourceId,
        reply,
        wasClarifying ? "queued" : "updated",
      );
      if (goal.kanbanTaskId) {
        goal.pendingOwnerUpdates ??= [];
        goal.pendingOwnerUpdates.push({
          sourceId,
          text,
          at: isoNow(),
          fromBlockedAnswer: wasBlocked,
        });
      }
      if (goal.status === "clarifying") {
        // Owner answered the broker's clarification — enter the commit window.
        goal.status = "queued";
        goal.releaseAt = new Date(Date.now() + releaseDelayMs()).toISOString();
        goal.clarificationQuestion = undefined;
      }
      if (goal.status === "blocked") {
        const now = isoNow();
        goal.blockedAnsweredAt = now;
        goal.lastBlockedPrompt = goal.lastBlockReason;
        goal.ownerSelection = normalizeOwnerSelection(text);
        goal.status = goal.kanbanTaskId ? "ready" : "queued";
        goal.lastKanbanStatus = goal.kanbanTaskId ? "ready" : undefined;
        goal.lastBlockReason = undefined;
        // Owner answered the blocked prompt — do not reset delivery to pending or
        // reconcileTask will re-SMS the same comparison question.
      }
    });
    if (!updated) return target;
    if (!applied) return updated;
    if (updated.kanbanTaskId) {
      const flushed = await this.flushOwnerUpdates(updated.id, wasBlocked).catch(() => false);
      if (!flushed) {
        return (
          (await this.store.update(updated.id, (goal) => {
            goal.intakeReply =
              `I saved that update for “${goal.title}” and will keep retrying the worker handoff.`;
            const receipt = goal.sourceReceipts?.find((item) => item.sourceId === sourceId);
            if (receipt) receipt.reply = goal.intakeReply;
          })) ?? updated
        );
      }
    }
    return (await this.store.get(updated.id)) ?? updated;
  }

  private async flushOwnerUpdates(goalId: string, forceUnblock = false): Promise<boolean> {
    const goal = await this.store.get(goalId);
    if (!goal?.kanbanTaskId || !goal.pendingOwnerUpdates?.length) return true;
    const applied: string[] = [];
    for (const update of goal.pendingOwnerUpdates) {
      const append = update.fromBlockedAnswer
        ? ownerSelectionKanbanAppend(update.text, update.at, update.sourceId)
        : ownerUpdateKanbanAppend(update.text, update.at, update.sourceId);
      const appended = await callKanbanBridge({
        action: "append_body",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: goal.kanbanTaskId,
        append,
      });
      if (!appended.success) return false;
      applied.push(update.sourceId);
    }
    const shouldUnblock = forceUnblock || goal.lastKanbanStatus === "blocked";
    if (shouldUnblock) {
      const unblocked = await callKanbanBridge({
        action: "unblock",
        board: REALTIME_GOALS_KANBAN_BOARD,
        task_id: goal.kanbanTaskId,
      });
      if (!unblocked.success) return false;
    }
    await this.store.update(goalId, (item) => {
      item.pendingOwnerUpdates = (item.pendingOwnerUpdates ?? []).filter(
        (update) => !applied.includes(update.sourceId),
      );
      if (shouldUnblock) {
        item.status = "ready";
        item.lastKanbanStatus = "ready";
        return;
      }
      // Append-only on a terminal task: wake reconciliation without clearing the
      // done cursor (prevents re-sending an old completion summary on the next tick).
      if (item.lastKanbanStatus === "done" || item.lastKanbanStatus === "archived") {
        item.status = "running";
        return;
      }
      item.status = "ready";
    });
    return true;
  }

  async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.recoverStaleInbound();
      const outstanding = await this.store.listOutstanding();
      if (outstanding.length === 0) return;
      await this.ensureBoard();
      for (const goal of outstanding) {
        if (goal.status === "cancelled") {
          await this.reconcileCancelledTombstone(goal);
          continue;
        }
        if (goal.status === "cancelling") {
          await this.retryCancellation(goal.id);
          continue;
        }
        if (goal.pendingOwnerUpdates?.length) {
          const forceUnblock = goal.pendingOwnerUpdates.some((update) => update.fromBlockedAnswer);
          const flushed = await this.flushOwnerUpdates(goal.id, forceUnblock).catch(() => false);
          if (!flushed) continue;
        }
        if (
          (goal.status === "queued" || goal.status === "releasing") &&
          goal.releaseAt &&
          Date.parse(goal.releaseAt) <= Date.now()
        ) {
          await this.release(goal);
          continue;
        }
        if (goal.kanbanTaskId) await this.reconcileTask(goal);
      }
    } catch (error) {
      console.warn(`[realtime-goals] lifecycle tick failed: ${(error as Error).message}`);
    } finally {
      this.tickRunning = false;
    }
  }

  private async reconcileCancelledTombstone(goal: RealtimeGoalRecord): Promise<void> {
    if (goal.kanbanTaskId || goal.cancellationReconciledAt) return;
    const found = await callKanbanBridge({
      action: "find_by_idempotency",
      board: REALTIME_GOALS_KANBAN_BOARD,
      idempotency_key: goal.idempotencyKey,
      include_archived: true,
    });
    const taskId = found.task?.task_id;
    if (!found.success || !taskId) {
      await this.store.update(goal.id, (item) => {
        item.cancellationReconciledAt = isoNow();
      });
      return;
    }
    await this.store.update(goal.id, (item) => {
      item.kanbanTaskId = taskId;
      item.status = "cancelling";
    });
    await this.retryCancellation(goal.id);
  }

  private async recoverStaleInbound(): Promise<void> {
    const stale = await this.store.listStaleInbound(2 * 60_000);
    for (const inbound of stale) {
      // Twilio was ACKed only after this reservation. If the process died
      // before handling it, make the loss visible and ask for a safe replay.
      if (inbound.origin.channel !== "sms") continue;
      const now = isoNow();
      const synthetic: RealtimeGoalRecord = {
        id: inbound.id,
        version: 1,
        title: "Interrupted SMS",
        objective: inbound.text,
        status: "failed",
        origin: inbound.origin,
        sourceMessageId: inbound.origin.messageId || inbound.id,
        idempotencyKey: `recovery:${inbound.id}`,
        createdAt: inbound.receivedAt,
        updatedAt: now,
        ownerInteractedAt: inbound.receivedAt,
        messages: [{ at: inbound.receivedAt, role: "owner", text: inbound.text }],
        intakeReply: "",
        delivery: { state: "pending", attempts: 0 },
      };
      const preview = inbound.text.replace(/\s+/g, " ").slice(0, 160);
      const result = await this.deliver(
        synthetic,
        `I restarted before I could finish processing this text: “${preview}”. Please resend it.`,
        "failed",
      ).catch(() => ({ delivered: false }));
      if (result.delivered) await this.store.markInboundRecoveryNotified(inbound.id);
    }
  }

  private async ensureBoard(): Promise<void> {
    if (this.boardReady) return;
    const filesRoot = resolveJoshuFilesPaths(this.projectRoot)?.filesRoot;
    if (!filesRoot) throw new Error("JOSHU_FILES_ROOT unavailable");
    const result = await ensureRealtimeGoalsBoard(filesRoot);
    if (!result.success) throw new Error(result.error || "could not ensure realtime-goals board");
    this.boardReady = true;
  }

  private async release(goal: RealtimeGoalRecord): Promise<void> {
    const claimed = await this.store.update(goal.id, (item) => {
      if (item.status === "queued") item.status = "releasing";
    });
    if (!claimed || claimed.status === "cancelled") return;
    const filesRoot = resolveJoshuFilesPaths(this.projectRoot)?.filesRoot;
    if (!filesRoot) return;

    const result = await callKanbanBridge({
      action: "create",
      board: REALTIME_GOALS_KANBAN_BOARD,
      title: claimed.title,
      body: taskBody(claimed),
      assignee: eaSchedulingKanbanAssignee(),
      idempotency_key: claimed.idempotencyKey,
      strict_idempotency: true,
      skills: ["realtime-goal"],
      workspace_kind: "dir",
      workspace_path: filesRoot,
      ...eaKanbanCreateDefaults(REALTIME_GOALS_KANBAN_BOARD),
    });
    if (!result.success || !result.task_id) {
      await this.store.update(goal.id, (item) => {
        if (item.status === "releasing") item.status = "queued";
      });
      throw new Error(result.error || "Kanban create failed");
    }
    const finalized = await this.store.update(goal.id, (item) => {
      item.kanbanTaskId = result.task_id;
      item.lastKanbanStatus = result.task?.status;
      if (item.status !== "cancelled" && item.status !== "cancelling") {
        item.status = (result.task?.status as RealtimeGoalRecord["status"]) || "ready";
      }
    });
    if (finalized?.status === "cancelled" || finalized?.status === "cancelling") {
      // Cancellation may win while create_task is in flight. Preserve the
      // cancelled state and immediately stop/archive the task that appeared.
      await this.store.update(goal.id, (item) => {
        item.status = "cancelling";
      });
      await this.retryCancellation(goal.id);
      return;
    }
    console.info(`[realtime-goals] released goal=${goal.id} task=${result.task_id}`);
  }

  private async reconcileTask(goal: RealtimeGoalRecord): Promise<void> {
    const result = await callKanbanBridge({
      action: "show",
      board: REALTIME_GOALS_KANBAN_BOARD,
      task_id: goal.kanbanTaskId,
      include_activity: true,
      include_run: true,
    });
    const task = result.task;
    if (!result.success || !task?.status) return;
    const status = task.status;

    if (status === "blocked") {
      const reason = task.block_reason?.trim() || "I need more information before I can continue.";
      const suppressRepeat = shouldSuppressRepeatBlockedPrompt(goal, reason);
      const reasonChanged =
        goal.lastKanbanStatus !== "blocked" || goal.lastBlockReason !== reason;
      if (reasonChanged) {
        await this.store.update(goal.id, (item) => {
          item.status = "blocked";
          item.lastKanbanStatus = "blocked";
          item.lastBlockReason = reason;
          if (!suppressRepeat) {
            item.delivery.state = "pending";
            item.delivery.attempts = 0;
            item.delivery.nextAttemptAt = undefined;
            item.delivery.lastDeliveredKey = undefined;
          }
        });
        await this.setActiveGoalPointer(goal.origin, goal.id);
        if (suppressRepeat) {
          console.info(
            `[realtime-goals] suppressed repeat blocked SMS goal=${goal.id} (owner already answered)`,
          );
        } else {
          await this.deliverAndRecord(goal.id, reason, "blocked");
        }
      } else if (
        !suppressRepeat &&
        (goal.delivery.state === "pending" || goal.delivery.state === "attempting")
      ) {
        await this.deliverAndRecord(goal.id, reason, "blocked");
      }
      return;
    }

    if (status === "done") {
      if (goal.status === "cancelled" || goal.delivery.state === "suppressed") return;
      const newCompletion = goal.lastKanbanStatus !== "done";
      const run = task.latest_run;
      const summary =
        run?.summary?.trim() ||
        task.completion_summary?.trim() ||
        task.recent_comments?.at(-1)?.body?.trim() ||
        `Completed “${goal.title}.”`;
      await this.store.update(goal.id, (item) => {
        item.status = "done";
        item.lastKanbanStatus = "done";
        item.resultSummary = summary;
        if (newCompletion) {
          item.delivery.state = "pending";
          item.delivery.attempts = 0;
          item.delivery.nextAttemptAt = undefined;
        }
      });
      const shouldDeliver = newCompletion || goal.delivery.state !== "delivered";
      if (shouldDeliver) {
        await this.deliverAndRecord(goal.id, summary, "completed");
      }
      await this.clearActiveGoalPointer(goal.origin);
      return;
    }

    if (status === "archived") {
      if (goal.status === "cancelled" || goal.delivery.state === "suppressed") return;
      const message =
        task.latest_run?.error?.trim() ||
        task.latest_run?.summary?.trim() ||
        `I couldn't finish “${goal.title}.”`;
      const newFailure = goal.lastKanbanStatus !== "archived";
      await this.store.update(goal.id, (item) => {
        item.status = "failed";
        item.lastKanbanStatus = "archived";
        item.resultSummary = message;
        if (newFailure) {
          item.delivery.state = "pending";
          item.delivery.attempts = 0;
          item.delivery.nextAttemptAt = undefined;
        }
      });
      const shouldDeliver = newFailure || goal.delivery.state !== "delivered";
      if (shouldDeliver) {
        await this.deliverAndRecord(goal.id, message, "failed");
      }
      await this.clearActiveGoalPointer(goal.origin);
      return;
    }

    await this.store.update(goal.id, (item) => {
      item.lastKanbanStatus = status;
      item.status = status === "running" ? "running" : "ready";
    });
  }

  private async deliverAndRecord(
    goalId: string,
    text: string,
    kind: "blocked" | "completed" | "failed",
  ): Promise<void> {
    const claim = await this.store.claimDeliveryAttempt(
      goalId,
      kind,
      text,
      MAX_DELIVERY_ATTEMPTS,
    );
    if (!claim.claimed || !claim.goal) return;

    const goal = claim.goal;
    if (
      goal.origin.channel === "jchat" ||
      goal.origin.channel === "agui" ||
      goal.origin.channel === "browser_voice"
    ) {
      const alreadyQueued = goal.surfaceEvents?.some(
        (event) => event.kind === kind && event.text === text && !event.consumedAt,
      );
      if (!alreadyQueued) {
        await this.store.update(goalId, (item) => {
          item.surfaceEvents ??= [];
          item.surfaceEvents.push({
            id: randomUUID(),
            kind,
            text,
            createdAt: isoNow(),
          });
        });
      }
    }

    const result: Awaited<ReturnType<RealtimeGoalDeliveryHandler>> = await this.deliver(
      goal,
      text,
      kind,
    ).catch((error) => ({
      delivered: false,
      error: (error as Error).message,
    }));
    await this.store.finalizeDeliveryAttempt(
      goalId,
      claim.contentKey,
      result,
      MAX_DELIVERY_ATTEMPTS,
    );
    if (result.delivered) {
      await this.recordBoxTurn(goal.origin, text, "delivery", goal.id);
    }
  }
}
