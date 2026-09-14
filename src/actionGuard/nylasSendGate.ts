import type { Request } from "express";
import { hasRecentSmsHandoff } from "../browserHandoff/store.js";
import { isOwnerSmsRecentlyActive } from "../twilioSmsSession.js";
import { isJmailOwnerClient } from "./agentRestGate.js";
import { awaitOwnerApproval, buildNylasSendSummary } from "./gate.js";
import { isActionGuardEnabled } from "./policy.js";
import { stubNylasSendResponse } from "./stubs.js";
import { applySchedulingSendFollowup } from "../ea/schedulingSendFollowup.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Agent mail send during an SMS chat should be a plain assistant reply, not Nylas. */
function shouldBlockNylasForSmsChannel(body: Record<string, unknown>, projectRoot: string): boolean {
  // EA mail workers and jMail thread replies legitimately use Nylas.
  if (readString(body.kanbanTaskId ?? body.kanban_task_id)) return false;
  if (readString(body.sourcePath ?? body.source_path)) return false;
  return isOwnerSmsRecentlyActive(projectRoot) || hasRecentSmsHandoff(projectRoot);
}

/** @deprecated Use isJmailOwnerClient */
export const isJmailOwnerSend = isJmailOwnerClient;

export type NylasSendGateResult =
  | { allowed: true }
  | { allowed: false; stub: Record<string, unknown> }
  | { allowed: false; unavailable: { code: string; message: string } };

/** Owner approval gate for agent Nylas sends (REST layer — closes execute_code bypass). */
export async function gateNylasSendRequest(
  req: Request,
  body: Record<string, unknown>,
  projectRoot: string,
): Promise<NylasSendGateResult> {
  if (isJmailOwnerSend(req)) {
    return { allowed: true };
  }

  // Always block agent email on SMS — independent of action-guard toggle.
  if (shouldBlockNylasForSmsChannel(body, projectRoot)) {
    return {
      allowed: false,
      unavailable: {
        code: "nylas_send_blocked_sms_channel",
        message:
          "Owner is on SMS. Put your answer in your assistant reply text — Joshu sends SMS automatically. " +
          "Do not use nylas_send_message or email the owner after browser handoff on SMS.",
      },
    };
  }

  if (!isActionGuardEnabled(projectRoot)) {
    return { allowed: true };
  }

  const summary = buildNylasSendSummary(body);
  const result = await awaitOwnerApproval({ actionId: "nylas_send_message", summary }, projectRoot);

  if (result.decision === "unavailable") {
    // Fire-and-forget Kanban rewrite when meeting workers passed kanbanTaskId.
    void applySchedulingSendFollowup({
      projectRoot,
      body,
      outcome: {
        kind: "unavailable",
        code: result.unavailableCode,
        message: result.unavailableReason,
      },
    });
    return {
      allowed: false,
      unavailable: {
        code: result.unavailableCode ?? "action_guard_unavailable",
        message: result.unavailableReason ?? "Action guard is unavailable",
      },
    };
  }
  if (result.decision === "denied" || result.decision === "timeout") {
    void applySchedulingSendFollowup({
      projectRoot,
      body,
      outcome: { kind: result.decision },
    });
    return { allowed: false, stub: stubNylasSendResponse(body, projectRoot) };
  }
  return { allowed: true };
}
