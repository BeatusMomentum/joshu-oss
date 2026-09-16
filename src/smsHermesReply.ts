/**
 * Owner SMS text from a completed Hermes turn.
 *
 * Hermes SessionDB holds the canonical assistant message (post DSML scrub at source).
 * SSE content deltas can diverge when models leak tool markup — prefer SessionDB for delivery.
 */

import { fetchHermesLastAssistantMessage } from "./hermesChatSessionsBridge.js";
import { smsModelReplyPlaintext } from "./smsModelReplyPlaintext.js";

export const SMS_EMPTY_REPLY_FALLBACK =
  "I didn't have a reply for that — try again or reply HELP.";

/** Resolve owner-facing SMS plain text after streamHermesChat completes. */
export async function ownerSmsTextFromHermesTurn(
  sessionKey: string,
  streamFinalText: string,
): Promise<string> {
  let raw = streamFinalText;
  try {
    const canonical = await fetchHermesLastAssistantMessage(sessionKey);
    if (canonical?.trim()) {
      raw = canonical;
    }
  } catch (err) {
    console.warn(
      `[sms] canonical assistant lookup failed session=${sessionKey.slice(0, 48)}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return smsModelReplyPlaintext(raw);
}
