/**
 * Shared Twilio SMS gateway configuration (timeout, default Hermes system prompt).
 */

import { envTrim } from "./twilioSmsSend.js";

/** Default Hermes turn budget for owner SMS (was 180s — too tight for tool-heavy resolve turns). */
export const SMS_HERMES_TIMEOUT_MS_DEFAULT = 300_000;

/** Min/max bounds when overriding via env. */
const SMS_HERMES_TIMEOUT_MS_MIN = 60_000;
const SMS_HERMES_TIMEOUT_MS_MAX = 600_000;

/** Hermes chat timeout for SMS ingress and proactive resolve turns. */
export function resolveSmsHermesTimeoutMs(): number {
  const raw = envTrim("JOSHU_SMS_HERMES_TIMEOUT_MS");
  if (!raw) return SMS_HERMES_TIMEOUT_MS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return SMS_HERMES_TIMEOUT_MS_DEFAULT;
  return Math.min(SMS_HERMES_TIMEOUT_MS_MAX, Math.max(SMS_HERMES_TIMEOUT_MS_MIN, n));
}

export function smsHermesAbortSignal(): AbortSignal {
  return AbortSignal.timeout(resolveSmsHermesTimeoutMs());
}

/** Default system prompt when TWILIO_SMS_SYSTEM_PROMPT is unset. */
export function defaultTwilioSmsSystemPrompt(): string {
  return [
    "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown or tables.",
    "Keep most replies short; Joshu splits long SMS automatically (handoff links are OK).",
    "SMS turns must be fast: answer from context you already have. Do not run deep investigations on SMS.",
    "Do not use session_search, execute_code, or terminal on SMS — they are slow and terminal needs desktop Safety approval the owner cannot give mid-text.",
    "If the owner continues a proactive nudge thread, Joshu routes you with Kanban resolve context — use kanban_show, not session_search.",
    "For login-gated sites (Amazon orders, bank, checkout, 2FA): load skill joshu-browser-handoff,",
    "navigate in the shared Camofox tab, call browser_handoff_request, and text the returned handoff URL.",
    "Do not guess from Gmail/Composio alone when the answer requires the owner's logged-in browser session.",
    "After handoff completes, reply with the answer in your assistant message only — never nylas_send_message on SMS.",
  ].join(" ");
}
