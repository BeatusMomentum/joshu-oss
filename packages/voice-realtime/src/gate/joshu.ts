/** Calls from the gate to Joshu's loopback API (service key + callback batch token). */
import { HERMES_API_KEY } from "../config.js";
import { voiceWarn } from "../voiceLog.js";

export const JOSHU_API_BASE = (process.env.JOSHU_API_BASE_URL ?? "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");

/** How a locked callback ended at the gate (mirrors RealtimeGoalVoiceCallbackOutcome). */
export type GateCallbackOutcome = "voicemail" | "auth_failed" | "no_unlock";

/**
 * Tell Joshu how a callback ended at the gate so the outbox texts the results
 * instead of redialing. Bounded: the caller is waiting on this TwiML response.
 */
export async function reportCallbackOutcome(
  callSid: string,
  batchId: string,
  batchToken: string,
  outcome: GateCallbackOutcome,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${JOSHU_API_BASE}/api/realtime-goals/voice/batch/${encodeURIComponent(batchId)}/outcome?token=${encodeURIComponent(batchToken)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HERMES_API_KEY}`,
          "X-Joshu-Voice-Call-Sid": callSid,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ outcome }),
        signal: AbortSignal.timeout(2_000),
      },
    );
    return response.ok;
  } catch (error) {
    voiceWarn(callSid, "gate", "callback outcome report failed", { outcome, error: (error as Error).message });
    return false;
  }
}
