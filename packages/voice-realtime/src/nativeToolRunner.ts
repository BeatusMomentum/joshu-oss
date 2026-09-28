/**
 * Native async-tool path (Gemini 3.8 Live), shared by phone and browser sessions.
 *
 * The voice model calls `think` (anything about the owner) or `start_task` (long
 * work) as NON_BLOCKING tools and keeps the conversation going. This module runs
 * the tool and builds the function response the model then speaks — replacing the
 * legacy wait lines, progress ticks, silent acks, and injected results.
 */

import {
  runJoshuThinkDetailed,
  speakableWithLinksTexted,
  startPhoneThinkJob,
  startVoiceTask,
  type DeliveredFact,
  type ThinkParams,
  type VoiceTaskParams,
} from "./brainThink.js";
import { VOICE_THINK_BUDGET_MS } from "./config.js";

/** Tools the native runner owns (dictation / open_desktop / app tools stay session-local). */
export const NATIVE_JOB_TOOL_NAMES: ReadonlySet<string> = new Set(["think", "start_task"]);

export type NativeToolRequest =
  | { kind: "think"; think: ThinkParams }
  | { kind: "start_task"; task: VoiceTaskParams };

export type NativeToolOutcome = {
  /** Function response for `sendFunctionResult`. */
  result: Record<string, unknown>;
  /** Unprocessed answer text (screen transcript, or texting after a phone hang-up). */
  rawText: string;
  source: "hermes" | "broker" | "task" | "error";
  /** Joshu inline job behind a phone think (detach it if the caller hangs up). */
  jobId?: string;
  /** Still running past the budget: the answer arrives later as a late-answer turn. */
  pending?: boolean;
  /** Sends Joshu made for this answer — the only basis for "I texted you". */
  delivered?: DeliveredFact[];
};

/** Function result while a phone think is still running past its budget. */
const STILL_WORKING_INSTRUCTION =
  "Tell the owner in one short sentence that you're still working on it and will tell them as soon as it's ready. Do not guess, and do not give a partial answer. Keep talking with them normally meanwhile.";

/** Only a listed, successful send may be described as done. */
function deliveredNote(delivered: DeliveredFact[]): string {
  const ok = delivered.filter((fact) => fact.ok);
  if (ok.length === 0) {
    return " Nothing was texted, emailed, or sent for this answer — never say it was.";
  }
  return " `delivered` lists what Joshu actually sent; mention only those sends.";
}

const RELAY_EXACT =
  "Keep every time, price, and name exactly as given. Do not add details that are not in the answer.";

/** How the model should voice a think result on this surface. */
function thinkRelayInstruction(presentation: ThinkParams["presentation"], source: "hermes" | "broker"): string {
  if (source === "broker") return "Relay this to the owner briefly in your own words.";
  if (presentation === "screen") {
    return `The full answer is already on the owner's screen. Speak a brief 1–3 sentence summary. ${RELAY_EXACT}`;
  }
  return `Relay this answer to the caller in plain, natural speech — they have no screen. ${RELAY_EXACT}`;
}

function errorOutcome(message: string): NativeToolOutcome {
  return {
    result: {
      status: "error",
      error: message.slice(0, 300),
      instruction:
        "Tell the owner briefly that you couldn't finish that just now. Do not read out technical details.",
    },
    rawText: "",
    source: "error",
  };
}

/**
 * Run one native tool call.
 * @param isDetached phone only — the caller hung up; skip speech post-processing
 *   (the session texts `rawText` instead, so links must not be texted twice).
 */
export async function runNativeVoiceTool(
  request: NativeToolRequest,
  isDetached: () => boolean = () => false,
): Promise<NativeToolOutcome> {
  if (request.kind === "start_task") {
    const queued = await startVoiceTask(request.task);
    if (!queued.ok) return errorOutcome(queued.error);
    return {
      result: {
        status: "queued",
        goal_id: queued.goalId,
        message: queued.reply,
        instruction:
          "Confirm to the owner in one or two natural sentences that this is queued and how they will hear back, then carry on.",
      },
      rawText: queued.reply,
      source: "task",
    };
  }

  const params = request.think;
  const onPhone = params.presentation !== "screen";
  if (onPhone && !params.appContext) {
    try {
      const job = await startPhoneThinkJob(params, VOICE_THINK_BUDGET_MS);
      if (job.status === "running") {
        return {
          result: { status: "working", job_id: job.jobId, instruction: STILL_WORKING_INSTRUCTION },
          rawText: "",
          source: "hermes",
          jobId: job.jobId,
          pending: true,
        };
      }
      if (job.status === "failed") return { ...errorOutcome(job.error ?? "think failed"), jobId: job.jobId };
      const source = job.source ?? "hermes";
      return {
        result: {
          status: "done",
          source,
          answer: job.answer ?? "",
          delivered: job.delivered,
          instruction: `${thinkRelayInstruction(params.presentation, source)}${deliveredNote(job.delivered)}`,
        },
        rawText: job.answer ?? "",
        source,
        jobId: job.jobId,
        delivered: job.delivered,
      };
    } catch (error) {
      // Joshu unreachable: fall back to asking Hermes directly (no budget).
      console.warn(`[voice-think] inline job unavailable, direct think: ${(error as Error).message}`);
    }
  }
  try {
    const answer = await runJoshuThinkDetailed(params);
    // Links cannot be spoken: Joshu texts them and returns speakable text.
    const spoken =
      onPhone && answer.source === "hermes" && !isDetached()
        ? await speakableWithLinksTexted(answer.text)
        : answer.text;
    return {
      result: {
        status: "done",
        source: answer.source,
        answer: spoken,
        instruction: thinkRelayInstruction(params.presentation, answer.source),
      },
      rawText: answer.text,
      source: answer.source,
    };
  } catch (error) {
    return errorOutcome(error instanceof Error ? error.message : String(error));
  }
}
