import { ActionGuardUnavailableError } from "../actionGuard/errors.js";
import { formatApprovalMessage } from "../actionGuard/approvalMessage.js";
import { markPendingNotified } from "../actionGuard/pending.js";
import { ownerSmsPhone, sendSms, twilioSmsGatewayEnabled } from "../twilioSmsSend.js";

export async function notifyOwnerForApproval(
  pendingId: string,
  actionId: string,
  summary: Record<string, unknown>,
  projectRoot = process.cwd(),
): Promise<"sms"> {
  if (!twilioSmsGatewayEnabled(projectRoot)) {
    throw new ActionGuardUnavailableError(
      "owner_channel_sms_not_configured",
      "Owner SMS not configured — set owner mobile in Telephone (or TWILIO_OWNER_CALLER) and Twilio account/number/webhook",
    );
  }

  const ownerPhone = ownerSmsPhone(projectRoot);
  if (!ownerPhone) {
    throw new ActionGuardUnavailableError(
      "owner_channel_not_linked",
      "Owner mobile is not set — add it in Telephone",
    );
  }

  const text = formatApprovalMessage(actionId, summary);
  try {
    await sendSms(ownerPhone, text);
    markPendingNotified(pendingId, projectRoot);
    return "sms";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ActionGuardUnavailableError(
      "owner_channel_sms_delivery_failed",
      `SMS approval notification failed: ${detail}`,
    );
  }
}
