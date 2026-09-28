/** Hermes inject wording for OpenAI Realtime speech after brain completes. */

export type InjectPresentation = "screen" | "voice_only";

/**
 * answer: a result to relay. question: Joshu needs the caller's decision to continue.
 * callback_*: same, on an outbound call Joshu placed — the model must lead with why it
 * called (it "forgot why it called" when handed a bare result, canary box 2026-09-25).
 * live_update: background work finished while the owner is on this call.
 * requested_callback: the owner asked to be called back and nothing is waiting.
 * control_turn: the text is a complete instruction written by Joshu (call opener).
 * late_answer: a think answer that outlasted its time budget, arriving mid-call.
 */
export type InjectKind =
  | "answer"
  | "question"
  | "callback_answer"
  | "callback_question"
  | "live_update"
  | "requested_callback"
  | "control_turn"
  | "late_answer";

const CALLBACK_HEADER =
  "[Joshu placed this call to the owner to report on background work they asked for earlier — they did not call you]";

/**
 * Phone relays must stay faithful: a loose "summary" dropped the takeoff times
 * the caller asked for and invented a fare that was not in the result
 * (canary box 2026-09-24).
 */
const VOICE_FIDELITY_RULES = [
  "Speak as yourself, in first person.",
  "Lead with the direct answer to what the caller asked.",
  "Keep every time, date, price, name, and number exactly as written — never invent, round, or drop one.",
  "Skip internal system details (error codes, browser or tool status).",
].join(" ");

export function injectHermesResultUserText(
  hermesText: string,
  presentation: InjectPresentation,
  kind: InjectKind = "answer",
): string {
  const trimmed = hermesText.trim();
  if (kind === "control_turn") return trimmed;
  if (presentation === "screen") {
    return `[Joshu completed — full answer is on the user's screen]\n${trimmed}\n\nSpeak a brief co-present summary (1–3 sentences). Mention that details are on screen when helpful.`;
  }
  if (kind === "callback_answer") {
    return `${CALLBACK_HEADER}\n${trimmed}\n\nOpen with one short line saying why you're calling (e.g. "I'm calling about the flights you asked me to check"), then relay the result. ${VOICE_FIDELITY_RULES} Finish by asking if there's anything else they'd like you to handle.`;
  }
  if (kind === "callback_question") {
    return `${CALLBACK_HEADER}\n${trimmed}\n\nOpen with one short line saying why you're calling, then explain what the task needs from them. ${VOICE_FIDELITY_RULES} Briefly give each option with its exact details, then ask the question plainly and stop to let them answer.`;
  }
  if (kind === "requested_callback") {
    return "[Joshu placed this call because the owner asked to be called back — nothing new to report]\nSay you're calling back as they asked, in one short line, and ask what they need.";
  }
  if (kind === "late_answer") {
    return `[Joshu: the answer to what the owner asked a moment ago is ready — you told them you were still working on it]\n${trimmed}\n\nAt a natural pause — never cutting the owner off — relay it. ${VOICE_FIDELITY_RULES}`;
  }
  if (kind === "live_update") {
    return `[Joshu: background work the owner asked for earlier just finished while they are on this call]\n${trimmed}\n\nAt a natural pause — never cutting the owner off — say in one short line that it is ready, then relay it. ${VOICE_FIDELITY_RULES}`;
  }
  if (kind === "question") {
    return `[Joshu needs the caller's decision — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} Briefly give each option with its exact details, then ask the question plainly and stop to let them answer.`;
  }
  return `[Joshu completed — user has no screen]\n${trimmed}\n\n${VOICE_FIDELITY_RULES} If it asks the caller something, end by asking that question plainly.`;
}
