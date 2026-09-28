import type { RealtimeGoalVoiceCallbackOutcome } from "./types.js";

/** Twilio call-status helpers for owner callbacks (the owner outbox decides what happens next). */

/** Twilio CallStatus values that end a call. */
const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export function isTerminalCallStatus(status: string): boolean {
  return TERMINAL_CALL_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Map Twilio AMD `AnsweredBy` to an outcome. `human` and `unknown` return
 * undefined — AMD is a hint, not proof, so the call gate decides.
 */
export function answeredByOutcome(
  answeredBy: string | undefined,
): RealtimeGoalVoiceCallbackOutcome | undefined {
  const value = answeredBy?.trim().toLowerCase() ?? "";
  if (value.startsWith("machine") || value === "fax") return "voicemail";
  return undefined;
}
