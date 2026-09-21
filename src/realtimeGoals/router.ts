import {
  day0ChatCompletion,
  isDay0LlmConfigured,
} from "../day0/llm.js";
import { formatSessionThreadForPrompt } from "./sessionThread.js";
import type { RealtimeGoalRecord, SessionThreadTurn } from "./types.js";

export type RealtimeGoalRouteDecision = {
  decision: "pass" | "clarify" | "queue" | "update" | "cancel" | "status" | "ack";
  confidence: number;
  goalId?: string;
  title?: string;
  question?: string;
  reply?: string;
  reason: string;
};

/** @deprecated Use RealtimeGoalRouteDecision */
export type RealtimeGoalAdmission = RealtimeGoalRouteDecision;

export type RouteRealtimeGoalMessageInput = {
  text: string;
  activeGoals: RealtimeGoalRecord[];
  threadTurns: SessionThreadTurn[];
  queueCapable: boolean;
  /** When set, classify continue-vs-pivot for the open branch (LLM, not phrase lists). */
  activeBranch?: RealtimeGoalRecord;
};

export type RouteRealtimeGoalMessageOptions = {
  completionOverride?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
};

const QUEUE_CONFIDENCE = 0.82;
const RELATION_CONFIDENCE = 0.68;
const CANCEL_CONFIDENCE = 0.75;
const CLASSIFIER_TIMEOUT_MS = 8_000;

const EXPLICIT_CANCEL_PATTERN =
  /^(never mind|nevermind|cancel that|stop that|forget it)[.! ]*$/;

const UNBOUND_SYSTEM_PROMPT = `You are a lightweight router for a personal AI assistant's realtime channels.
Classify the owner's latest message when there is NO active branch already bound on this trunk.
Output JSON only:
{
  "decision": "pass" | "queue" | "cancel" | "status" | "ack",
  "confidence": 0..1,
  "goal_id": string or null,
  "title": short task title or null,
  "reply": one concise owner-facing reply or null,
  "reason": one short internal reason
}

Policy:
- Read the latest owner message in light of the immediately preceding box turn.
- "ack": the owner is answering a box prompt (e.g. "Anything else?" → "Nope", "No thanks").
  Provide a brief reply in "reply". Do not cancel or queue.
- "pass": casual conversation, a quick answer, or anything plausibly finishable in about 60 seconds.
- "queue": clearly new long goal-oriented work that should run in the background Kanban worker.
- Be LENIENT toward pass on queue-capable channels. False async is worse than a missed async.
- "cancel": the owner wants an active goal stopped ("actually, never mind", "cancel that").
  Bare negation answering "Anything else?" is ack, not cancel.
- "status": the owner asks about an active goal.
- Do not create a new goal for follow-ups on the same job — those continue the active branch.
- Select goal_id only from the listed active goals (for cancel/status).
- When queue_capable is false, always return decision "pass".
- Some channels wrap owner text in structured fields (Intent / Conversation summary / User said).
  Treat User said as the verbatim request when present.`;

const BOUND_SYSTEM_PROMPT = `You route messages when ONE active background branch is already open on this trunk.
Read the recent owner↔box thread and the active branch summary.
Output JSON only:
{
  "decision": "pass" | "queue" | "update" | "cancel" | "status" | "ack",
  "confidence": 0..1,
  "goal_id": string or null,
  "title": short task title or null,
  "reply": one concise owner-facing reply or null,
  "reason": one short internal reason
}

Policy:
- "update": the latest message continues the SAME background job (answers a blocked question,
  picks an option, adds detail, short follow-up on that job).
- "queue": the owner asked for clearly NEW unrelated long work — a different task than the
  active branch (even if they say "something new" or pivot mid-thread).
- "pass": casual conversation or anything plausibly finishable in about 60 seconds.
- "ack": owner answering a box prompt ("Anything else?" → "Nope"). Provide brief "reply".
- "cancel" / "status": same as usual; goal_id must be the active branch unless ambiguous.
- When uncertain between update and queue, prefer update only if the message plainly continues
  the active branch objective; otherwise queue the new work.
- Be lenient toward pass for borderline quick chat on queue-capable channels.
- When queue_capable is false, always return decision "pass".`;

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function short(value: unknown, max: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : undefined;
}

function normalizeAdmissionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isExplicitCancelPhrase(text: string): boolean {
  return EXPLICIT_CANCEL_PATTERN.test(normalizeAdmissionText(text));
}

function threadReferencesActiveGoal(
  threadTurns: SessionThreadTurn[],
  activeGoals: RealtimeGoalRecord[],
): boolean {
  if (activeGoals.length === 0) return false;
  const recent = threadTurns.slice(-6).map((turn) => turn.text.toLowerCase()).join("\n");
  return activeGoals.some((goal) => {
    const title = goal.title.toLowerCase();
    return title.length >= 4 && recent.includes(title.slice(0, Math.min(title.length, 40)));
  });
}

function latestActive(activeGoals: RealtimeGoalRecord[]): RealtimeGoalRecord | undefined {
  return [...activeGoals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function activeGoalsPrompt(activeGoals: RealtimeGoalRecord[]): string {
  if (activeGoals.length === 0) return "(none)";
  return activeGoals
    .slice(0, 8)
    .map((goal) => {
      const lastOwner = [...goal.messages].reverse().find((message) => message.role === "owner");
      return [
        `- id=${goal.id}`,
        `status=${goal.status}`,
        `title=${JSON.stringify(goal.title)}`,
        `objective=${JSON.stringify(goal.objective.slice(0, 500))}`,
        lastOwner ? `latest=${JSON.stringify(lastOwner.text.slice(0, 300))}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

function normalize(
  parsed: Record<string, unknown>,
  text: string,
  activeGoals: RealtimeGoalRecord[],
  threadTurns: SessionThreadTurn[],
  queueCapable: boolean,
  bound = false,
): RealtimeGoalRouteDecision {
  if (!queueCapable) {
    return { decision: "pass", confidence: 1, reason: "sync_only_channel" };
  }

  const raw = String(parsed.decision ?? "pass").trim().toLowerCase();
  const allowed = bound
    ? new Set(["pass", "queue", "update", "cancel", "status", "ack"])
    : new Set(["pass", "queue", "cancel", "status", "ack"]);
  let decision = (allowed.has(raw) ? raw : "pass") as RealtimeGoalRouteDecision["decision"];
  const confidence = clampConfidence(parsed.confidence);
  const goalId = short(parsed.goal_id, 100);
  const knownGoal = goalId ? activeGoals.some((goal) => goal.id === goalId) : false;

  // Legacy classifier outputs — fold into the slim router.
  if (!bound && (raw === "clarify" || raw === "update")) {
    decision = raw === "clarify" && confidence >= QUEUE_CONFIDENCE ? "queue" : "pass";
  }
  if (bound && raw === "clarify") {
    decision = confidence >= RELATION_CONFIDENCE ? "update" : "pass";
  }

  if (decision === "queue" && confidence < QUEUE_CONFIDENCE) {
    decision = "pass";
  }
  if (
    decision === "update" &&
    (confidence < RELATION_CONFIDENCE || (goalId && !knownGoal))
  ) {
    decision = "pass";
  }
  if (decision === "status" && (confidence < RELATION_CONFIDENCE || !knownGoal)) {
    decision = "pass";
  }
  if (decision === "cancel") {
    const explicit = isExplicitCancelPhrase(text);
    const threadContext = threadReferencesActiveGoal(threadTurns, activeGoals);
    if (
      confidence < CANCEL_CONFIDENCE ||
      (!knownGoal && !threadContext && !explicit)
    ) {
      decision = "ack";
    } else if (decision === "cancel" && !knownGoal && activeGoals.length === 1) {
      const onlyGoal = activeGoals[0];
      if (!onlyGoal) {
        decision = "ack";
      } else {
        return {
          decision: "cancel",
          confidence,
          goalId: onlyGoal.id,
          reason: short(parsed.reason, 200) ?? "classified",
        };
      }
    } else if (decision === "cancel" && !knownGoal) {
      decision = "ack";
    }
  }

  const reply = short(parsed.reply, 320);
  if (decision === "ack" && !reply) {
    decision = "pass";
  }

  return {
    decision,
    confidence,
    ...(knownGoal && goalId ? { goalId } : {}),
    ...(short(parsed.title, 120) ? { title: short(parsed.title, 120) } : {}),
    ...(reply ? { reply } : {}),
    reason: short(parsed.reason, 200) ?? "classified",
  };
}

function deterministicRoute(
  text: string,
  activeGoals: RealtimeGoalRecord[],
  queueCapable: boolean,
): RealtimeGoalRouteDecision | undefined {
  if (!queueCapable) {
    return { decision: "pass", confidence: 1, reason: "sync_only_channel" };
  }

  const normalized = normalizeAdmissionText(text);
  const latest = activeGoals.length === 1 ? latestActive(activeGoals) : undefined;

  if (latest && EXPLICIT_CANCEL_PATTERN.test(normalized)) {
    return {
      decision: "cancel",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_cancel",
    };
  }
  if (
    latest &&
    /^(status|update|how(?:'s| is) that going|is it done|what's the status)[?!. ]*$/.test(
      normalized,
    )
  ) {
    return {
      decision: "status",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_status",
    };
  }
  if (/^(hi|hello|hey|good morning|good night)[!,. ]*$/.test(normalized)) {
    return { decision: "pass", confidence: 1, reason: "quick_conversation" };
  }
  return undefined;
}

function activeBranchPrompt(branch: RealtimeGoalRecord): string {
  const lastOwner = [...branch.messages].reverse().find((message) => message.role === "owner");
  return [
    `- id=${branch.id}`,
    `status=${branch.status}`,
    `title=${JSON.stringify(branch.title)}`,
    `objective=${JSON.stringify(branch.objective.slice(0, 500))}`,
    lastOwner ? `latest=${JSON.stringify(lastOwner.text.slice(0, 300))}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function runRouterCompletion(
  input: RouteRealtimeGoalMessageInput,
  options: RouteRealtimeGoalMessageOptions | undefined,
  systemPrompt: string,
  userContent: string,
  bound: boolean,
): Promise<RealtimeGoalRouteDecision> {
  const goalsForCancel = input.activeBranch
    ? [input.activeBranch, ...input.activeGoals.filter((goal) => goal.id !== input.activeBranch!.id)]
    : input.activeGoals;

  const deterministic = deterministicRoute(
    input.text,
    goalsForCancel,
    input.queueCapable,
  );
  if (deterministic) return deterministic;

  if (!isDay0LlmConfigured() && !options?.completionOverride) {
    return { decision: "pass", confidence: 0, reason: "router_unconfigured_fail_open" };
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const runCompletion = options?.completionOverride
    ? () => options.completionOverride!(messages)
    : () =>
        day0ChatCompletion(messages as Array<{ role: "system" | "user"; content: string }>, {
          json: true,
          maxTokens: 350,
          model:
            process.env.JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL?.trim() ||
            process.env.JOSHU_EA_CLASSIFIER_MODEL?.trim() ||
            "openai/gpt-5.4-nano",
          traceName: bound ? "realtime-goal-bound-router" : "realtime-goal-router",
          generationName: bound ? "route-bound-realtime-goal" : "route-realtime-goal",
          tags: ["realtime", "goal", "router", ...(bound ? ["bound"] : [])],
          metadata: {
            activeGoalCount: input.activeGoals.length,
            threadTurnCount: input.threadTurns.length,
            boundBranchId: input.activeBranch?.id,
          },
        });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      runCompletion(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("router timeout")),
          CLASSIFIER_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    return normalize(
      JSON.parse(raw) as Record<string, unknown>,
      input.text,
      goalsForCancel,
      input.threadTurns,
      input.queueCapable,
      bound,
    );
  } catch (error) {
    console.warn(`[realtime-goals] router failed open: ${(error as Error).message}`);
    return { decision: "pass", confidence: 0, reason: "router_error_fail_open" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function routeRealtimeGoalMessage(
  input: RouteRealtimeGoalMessageInput,
  options?: RouteRealtimeGoalMessageOptions,
): Promise<RealtimeGoalRouteDecision> {
  const threadPrompt = formatSessionThreadForPrompt(input.threadTurns);

  if (input.activeBranch) {
    const branch = input.activeBranch;
    const userContent = [
      `queue_capable: ${input.queueCapable}`,
      "",
      "Active branch (bound):",
      activeBranchPrompt(branch),
      "",
      "Other active goals:",
      activeGoalsPrompt(
        input.activeGoals.filter((goal) => goal.id !== branch.id),
      ),
      "",
      "Recent owner↔box thread:",
      threadPrompt,
      "",
      "Latest owner message:",
      input.text.slice(0, 4000),
    ].join("\n");
    return runRouterCompletion(
      input,
      options,
      BOUND_SYSTEM_PROMPT,
      userContent,
      true,
    );
  }

  const userContent = [
    `queue_capable: ${input.queueCapable}`,
    "",
    "Active goals:",
    activeGoalsPrompt(input.activeGoals),
    "",
    "Recent owner↔box thread:",
    threadPrompt,
    "",
    "Latest owner message:",
    input.text.slice(0, 4000),
  ].join("\n");

  return runRouterCompletion(
    input,
    options,
    UNBOUND_SYSTEM_PROMPT,
    userContent,
    false,
  );
}

/** Back-compat alias for older imports and tests. */
export async function classifyRealtimeGoalMessage(
  text: string,
  activeGoals: RealtimeGoalRecord[],
  options?: RouteRealtimeGoalMessageOptions & {
    threadTurns?: SessionThreadTurn[];
    queueCapable?: boolean;
  },
): Promise<RealtimeGoalRouteDecision> {
  return routeRealtimeGoalMessage(
    {
      text,
      activeGoals,
      threadTurns: options?.threadTurns ?? [],
      queueCapable: options?.queueCapable ?? true,
    },
    options,
  );
}
