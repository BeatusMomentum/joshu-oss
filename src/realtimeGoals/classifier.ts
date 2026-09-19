import {
  day0ChatCompletion,
  isDay0LlmConfigured,
} from "../day0/llm.js";
import type { RealtimeGoalRecord } from "./types.js";

export type RealtimeGoalAdmission = {
  decision: "pass" | "clarify" | "queue" | "update" | "cancel" | "status";
  confidence: number;
  goalId?: string;
  title?: string;
  question?: string;
  reason: string;
};

const QUEUE_CONFIDENCE = 0.82;
const RELATION_CONFIDENCE = 0.68;
const CLASSIFIER_TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = `You are an admission controller for a personal AI assistant's realtime channels.
Classify the owner's latest message. Output JSON only:
{
  "decision": "pass" | "clarify" | "queue" | "update" | "cancel" | "status",
  "confidence": 0..1,
  "goal_id": string or null,
  "title": short task title or null,
  "question": one concise clarification question or null,
  "reason": one short internal reason
}

Policy:
- "pass": casual conversation, a quick answer, a quick single tool lookup, or anything plausibly finishable in about 60 seconds.
- "queue": clearly longer goal-oriented work: multi-site research, browser workflows, bookings, multi-step document/project work, monitoring, or work likely to need several tools/retries.
- Be LENIENT toward pass. False async is worse than a missed async. Use queue only at high confidence.
- "clarify": the work is clearly long but a consequential detail is required before execution. Ask exactly one focused question. Do not clarify low-risk details that can use a reasonable default.
- "update": the latest message adds or changes details for an already queued/running/blocked goal.
- For a clarifying goal, choose "queue" with its goal_id when the answer is sufficient, or "clarify" with the same goal_id and the next required question.
- "cancel": the owner wants an active goal stopped ("never mind", "cancel that", etc.).
- "status": the owner asks about an active goal.
- A new request remains a new request even while other goals are active. Never attach it merely because a goal exists.
- Select goal_id only from the listed active goals.
- Some channels wrap the owner text in structured fields (Intent / Conversation summary / User said). Treat User said as the verbatim request when present; otherwise use the full message. Do not pass merely because Intent or summary look thin — classify the underlying work.`;

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function short(value: unknown, max: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : undefined;
}

function normalize(
  parsed: Record<string, unknown>,
  activeGoals: RealtimeGoalRecord[],
): RealtimeGoalAdmission {
  const raw = String(parsed.decision ?? "pass").trim().toLowerCase();
  const allowed = new Set(["pass", "clarify", "queue", "update", "cancel", "status"]);
  let decision = (allowed.has(raw) ? raw : "pass") as RealtimeGoalAdmission["decision"];
  const confidence = clampConfidence(parsed.confidence);
  const goalId = short(parsed.goal_id, 100);
  const knownGoal = goalId ? activeGoals.some((goal) => goal.id === goalId) : false;

  if ((decision === "queue" || decision === "clarify") && confidence < QUEUE_CONFIDENCE) {
    decision = "pass";
  }
  if (
    (decision === "update" || decision === "cancel" || decision === "status") &&
    (confidence < RELATION_CONFIDENCE || !knownGoal)
  ) {
    decision = "pass";
  }

  const question = short(parsed.question, 320);
  if (decision === "clarify" && !question) decision = "pass";

  return {
    decision,
    confidence,
    ...(knownGoal && goalId ? { goalId } : {}),
    ...(short(parsed.title, 120) ? { title: short(parsed.title, 120) } : {}),
    ...(question ? { question } : {}),
    reason: short(parsed.reason, 200) ?? "classified",
  };
}

function latestActive(activeGoals: RealtimeGoalRecord[]): RealtimeGoalRecord | undefined {
  return [...activeGoals].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function deterministicAdmission(
  text: string,
  activeGoals: RealtimeGoalRecord[],
): RealtimeGoalAdmission | undefined {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const latest = activeGoals.length === 1 ? latestActive(activeGoals) : undefined;
  if (latest && /^(never mind|nevermind|cancel that|stop that|forget it)[.! ]*$/.test(normalized)) {
    return {
      decision: "cancel",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_cancel",
    };
  }
  if (
    latest &&
    /^(status|update|how(?:'s| is) that going|is it done|what's the status)[?!. ]*$/.test(normalized)
  ) {
    return {
      decision: "status",
      confidence: 1,
      goalId: latest.id,
      reason: "explicit_latest_goal_status",
    };
  }
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good morning|good night)[!,. ]*$/.test(normalized)) {
    return { decision: "pass", confidence: 1, reason: "quick_conversation" };
  }
  return undefined;
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

export async function classifyRealtimeGoalMessage(
  text: string,
  activeGoals: RealtimeGoalRecord[],
): Promise<RealtimeGoalAdmission> {
  const deterministic = deterministicAdmission(text, activeGoals);
  if (deterministic) return deterministic;
  if (!isDay0LlmConfigured()) {
    return { decision: "pass", confidence: 0, reason: "classifier_unconfigured_fail_open" };
  }

  const completion = day0ChatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Active goals:\n${activeGoalsPrompt(activeGoals)}\n\nLatest owner message:\n${text.slice(0, 4000)}`,
      },
    ],
    {
      json: true,
      maxTokens: 300,
      model:
        process.env.JOSHU_REALTIME_GOALS_CLASSIFIER_MODEL?.trim() ||
        process.env.JOSHU_EA_CLASSIFIER_MODEL?.trim() ||
        "openai/gpt-5.4-nano",
      traceName: "realtime-goal-classifier",
      generationName: "classify-realtime-goal",
      tags: ["realtime", "goal", "classifier"],
      metadata: { activeGoalCount: activeGoals.length },
    },
  );

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("classifier timeout")),
          CLASSIFIER_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    return normalize(JSON.parse(raw) as Record<string, unknown>, activeGoals);
  } catch (error) {
    console.warn(`[realtime-goals] classifier failed open: ${(error as Error).message}`);
    return { decision: "pass", confidence: 0, reason: "classifier_error_fail_open" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
