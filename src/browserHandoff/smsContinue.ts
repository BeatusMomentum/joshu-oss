/**
 * After owner completes mobile browser handoff on SMS, wake Hermes on the same
 * sms: session and deliver the assistant reply as SMS (never nylas_send_message).
 */

import {
  HermesApiRunner,
  buildTurnSystemMessages,
  type HermesChatMessage,
} from "../hermesApi.js";
import { buildOwnerTimeSystemMessage } from "../ownerLocalTime.js";
import { ownerSmsTextFromHermesTurn } from "../smsHermesReply.js";
import { ownerSmsPhone, phonesMatch, sendSms } from "../twilioSmsSend.js";
import { resolveOwnerSmsSessionKey } from "../twilioSmsSession.js";
import { getHandoffRecord, markSmsContinuationDelivered, type BrowserHandoffRecord } from "./store.js";

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Parse E.164 phone from `sms:+1…:epoch` or sticky `sms:+1…`. */
export function phoneFromSmsHermesSessionKey(sessionKey: string): string | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("sms:")) return null;
  const rest = trimmed.slice(4);
  const phone = rest.split(":")[0]?.trim();
  if (!phone || phone === "unknown") return null;
  return phone;
}

/** True when this handoff should trigger an SMS continuation turn. */
export function shouldDeliverSmsHandoffContinuation(record: BrowserHandoffRecord): boolean {
  const sessionKey = record.hermesSessionKey?.trim() ?? "";
  if (!sessionKey.startsWith("sms:")) return false;
  return Boolean(phoneFromSmsHermesSessionKey(sessionKey));
}

/**
 * Run a Hermes turn on the originating SMS session and text the owner the assistant reply.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverSmsHandoffContinuation(
  projectRoot: string,
  record: BrowserHandoffRecord,
  runner: HermesApiRunner,
): Promise<{ delivered: boolean; error?: string }> {
  let active = record;
  if (!shouldDeliverSmsHandoffContinuation(record)) {
    // Kanban workers often mint the handoff without the owner's sms: session.
    const phone = ownerSmsPhone(projectRoot);
    if (!phone) {
      console.warn(
        `[browser-handoff] SMS continuation skipped handoff=${record.id.slice(0, 8)} (no sms session)`,
      );
      return { delivered: false, error: "not_sms_handoff" };
    }
    active = { ...record, hermesSessionKey: `sms:${phone}` };
    console.info(
      `[browser-handoff] SMS continuation using owner phone handoff=${record.id.slice(0, 8)}`,
    );
  }
  if (active.smsContinuationDeliveredAt) {
    return { delivered: false, error: "sms_continuation_already_delivered" };
  }

  // Let an in-flight Hermes poll turn finish (and hit the nylas SMS block) before we continue.
  await sleep(20_000);

  const fresh = getHandoffRecord(projectRoot, record.id);
  if (!fresh || fresh.smsContinuationDeliveredAt) {
    return { delivered: false, error: "sms_continuation_already_delivered" };
  }

  const ownerPhone = ownerSmsPhone(projectRoot);
  const handoffPhone = phoneFromSmsHermesSessionKey(active.hermesSessionKey!);
  if (!ownerPhone || !handoffPhone || !phonesMatch(handoffPhone, ownerPhone)) {
    return { delivered: false, error: "sms_handoff_not_owner_phone" };
  }

  const sessionKey = resolveOwnerSmsSessionKey(handoffPhone, projectRoot);
  const smsSystemPrompt =
    envOr("TWILIO_SMS_SYSTEM_PROMPT", "") ||
    [
      "You are Joshu on SMS with the box owner. Reply in concise plain text — no markdown or tables.",
      "After browser handoff completes, browser_snapshot and answer in assistant text only — never nylas_send_message.",
    ].join(" ");

  const messages: HermesChatMessage[] = [
    buildOwnerTimeSystemMessage(projectRoot),
    { role: "system", content: smsSystemPrompt },
    {
      role: "system",
      content:
        "The owner finished mobile browser handoff (tapped I'm done). " +
        "Use browser_snapshot to verify the page, then answer their request with what you find. " +
        "Put the full answer in your assistant reply — Joshu sends it as SMS. Do not email or nylas_send_message.",
    },
    {
      role: "user",
      content:
        `Browser handoff ${active.id} is complete.\n` +
        `Handoff instructions: ${active.instructions}\n` +
        `Staged page was: ${active.pageTitle || active.pageUrl}\n` +
        "Continue the task and text me the answer.",
    },
  ];

  // Must use the Joshu process singleton runner — a second HermesApiRunner would call
  // ensureApiServer() without owning this.gateway and SIGTERM the live gateway mid-stream.
  try {
    await runner.ensureGatewayReady();

    const { finalText } = await runner.streamHermesChat(
      {
        sessionId: sessionKey,
        sessionKey,
        messages: [...buildTurnSystemMessages(projectRoot), ...messages],
        signal: AbortSignal.timeout(240_000),
      },
      {},
    );
    const reply = await ownerSmsTextFromHermesTurn(sessionKey, finalText);
    if (!reply) {
      return { delivered: false, error: "empty_assistant_reply" };
    }
    await sendSms(handoffPhone, reply);
    markSmsContinuationDelivered(projectRoot, active.id);
    console.info(
      `[browser-handoff] SMS continuation delivered handoff=${active.id.slice(0, 8)} session=${sessionKey.slice(0, 24)}`,
    );
    return { delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[browser-handoff] SMS continuation failed handoff=${active.id}: ${message}`);
    return { delivered: false, error: message };
  }
}
