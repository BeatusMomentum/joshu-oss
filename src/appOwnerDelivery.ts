/**
 * Notify box owner via SMS when Twilio owner gateway is configured.
 */

import { ownerSmsPhone, sendSms, twilioSmsGatewayEnabled } from "./twilioSmsSend.js";

export type AppOwnerDeliveryInput = {
  appId: string;
  title: string;
  summary: string;
  link?: string;
};

/** Send a short app event summary to the owner by SMS when configured. */
export async function notifyOwnerAppEvent(
  input: AppOwnerDeliveryInput,
  projectRoot: string,
): Promise<{ delivered: boolean; channels: string[] }> {
  if (!twilioSmsGatewayEnabled(projectRoot)) return { delivered: false, channels: [] };

  const phone = ownerSmsPhone(projectRoot);
  if (!phone) return { delivered: false, channels: [] };

  const body = input.link
    ? `${input.title}\n${input.summary}\n\n${input.link}`
    : `${input.title}\n${input.summary}`;
  await sendSms(phone, body);
  return { delivered: true, channels: ["sms"] };
}
