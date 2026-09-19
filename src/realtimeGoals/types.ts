export type RealtimeGoalChannel =
  | "sms"
  | "jchat"
  | "agui"
  | "browser_voice"
  | "pstn_voice"
  | "slack"
  | "telegram";

export type RealtimeGoalOrigin = {
  channel: RealtimeGoalChannel;
  /** Stable conversation identity used for clarification and delivery. */
  sessionKey: string;
  /** Raw Hermes session id when it differs from sessionKey. */
  sessionId?: string;
  /** Provider event id. Used only for transport-level idempotency. */
  messageId?: string;
  /** SMS E.164, Slack channel id, or Telegram chat id. */
  replyAddress?: string;
  /** Slack thread_ts / Telegram message-thread id. */
  threadId?: string;
  appId?: string;
};

export type RealtimeGoalStatus =
  | "clarifying"
  | "queued"
  | "releasing"
  | "cancelling"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type RealtimeGoalMessage = {
  at: string;
  role: "owner" | "broker";
  text: string;
};

export type RealtimeGoalDelivery = {
  state: "pending" | "attempting" | "delivered" | "suppressed";
  attempts: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  attemptLeaseUntil?: string;
  deliveredAt?: string;
  /** Hash of kind+text for the last successful owner-channel delivery. */
  lastDeliveredKey?: string;
  lastError?: string;
  providerId?: string;
};

export type RealtimeGoalSurfaceEvent = {
  id: string;
  kind: RealtimeGoalDeliveryKind;
  text: string;
  createdAt: string;
  consumedAt?: string;
};

export type RealtimeGoalRecord = {
  id: string;
  version: 1;
  title: string;
  objective: string;
  status: RealtimeGoalStatus;
  origin: RealtimeGoalOrigin;
  sourceMessageId: string;
  /** Every provider event already applied to this goal (initial + updates/cancel/status). */
  handledSourceIds?: string[];
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  ownerInteractedAt?: string;
  releaseAt?: string;
  clarificationQuestion?: string;
  messages: RealtimeGoalMessage[];
  pendingOwnerUpdates?: Array<{
    sourceId: string;
    text: string;
    at: string;
    /** Set when the owner answered a blocked kanban prompt (hotel pick, etc.). */
    fromBlockedAnswer?: boolean;
  }>;
  kanbanTaskId?: string;
  lastKanbanStatus?: string;
  lastBlockReason?: string;
  /** When the owner replied while the goal was blocked waiting on input. */
  blockedAnsweredAt?: string;
  /** Block question text the owner already answered (for repeat-block suppression). */
  lastBlockedPrompt?: string;
  /** Normalized owner pick from a blocked prompt (e.g. "Holiday Inn"). */
  ownerSelection?: string;
  resultSummary?: string;
  cancelledAt?: string;
  cancelReason?: string;
  cancellationReconciledAt?: string;
  intakeReply: string;
  sourceReceipts?: Array<{
    sourceId: string;
    reply: string;
    outcome: "clarify" | "queued" | "updated" | "cancelled" | "status";
    at: string;
  }>;
  delivery: RealtimeGoalDelivery;
  surfaceEvents?: RealtimeGoalSurfaceEvent[];
};

export type RealtimeGoalState = {
  version: 1;
  goals: RealtimeGoalRecord[];
  inbox?: RealtimeGoalInboxRecord[];
};

export type RealtimeGoalInboxRecord = {
  id: string;
  origin: RealtimeGoalOrigin;
  text: string;
  receivedAt: string;
  processedAt?: string;
  recoveryNotifiedAt?: string;
};

export type RealtimeGoalRouteInput = {
  origin: RealtimeGoalOrigin;
  text: string;
};

export type RealtimeGoalRouteResult =
  | { action: "pass" }
  | {
      action: "reply";
      text: string;
      goalId?: string;
      outcome: "clarify" | "queued" | "updated" | "cancelled" | "status";
    };

export type RealtimeGoalDeliveryKind = "blocked" | "completed" | "failed";

export type RealtimeGoalDeliveryHandler = (
  goal: RealtimeGoalRecord,
  text: string,
  kind: RealtimeGoalDeliveryKind,
) => Promise<{
  delivered: boolean;
  pending?: boolean;
  providerId?: string;
  retryAt?: string;
  error?: string;
}>;

export function realtimeGoalSessionKey(origin: RealtimeGoalOrigin): string {
  return `${origin.channel}:${origin.sessionKey}`;
}

export function isRealtimeGoalActive(goal: RealtimeGoalRecord): boolean {
  return !["done", "failed", "cancelled"].includes(goal.status);
}
