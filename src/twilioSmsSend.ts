/**
 * Shared Twilio SMS send helper (owner SMS gateway + action-guard approvals).
 */

import twilio from "twilio";

import { resolveOwnerCaller } from "./telephoneSettings/resolve.js";

export const SMS_MAX_CHARS = 1500;

export function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const stripCountry = (p: string) => (p.startsWith("+1") ? p.slice(2) : p.replace(/^\+/, ""));
  return stripCountry(na) === stripCountry(nb);
}

function smsInboundWebhookUrl(): string | undefined {
  const explicit = envTrim("TWILIO_SMS_WEBHOOK_URL");
  if (explicit) return explicit;
  const voice = envTrim("TWILIO_VOICE_WEBHOOK_URL");
  if (!voice) return undefined;
  return voice.replace(/\/voice\/inbound\/?$/, "/sms/inbound");
}

/** Twilio account + box number + inbound webhook — enough to register SMS routes. */
export function twilioSmsAccountReady(): boolean {
  return Boolean(
    envTrim("TWILIO_AUTH_TOKEN") &&
      envTrim("TWILIO_ACCOUNT_SID") &&
      envTrim("TWILIO_PHONE_NUMBER") &&
      smsInboundWebhookUrl(),
  );
}

/**
 * Owner SMS is fully configured when Twilio is wired *and* an owner mobile is
 * known (Telephone settings file, then TWILIO_OWNER_CALLER).
 */
export function twilioSmsGatewayEnabled(projectRoot = process.cwd()): boolean {
  return twilioSmsAccountReady() && Boolean(ownerSmsPhone(projectRoot));
}

export function ownerSmsPhone(projectRoot = process.cwd()): string {
  return resolveOwnerCaller(projectRoot);
}

/** Send an outbound SMS from the box Twilio number to the owner (or any E.164). */
export async function sendSms(to: string, body: string): Promise<void> {
  const accountSid = envTrim("TWILIO_ACCOUNT_SID");
  const authToken = envTrim("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = envTrim("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = envTrim("TWILIO_PHONE_NUMBER");
  const client = twilio(accountSid, authToken);
  const text = body.slice(0, SMS_MAX_CHARS);
  if (messagingServiceSid) {
    await client.messages.create({ to, messagingServiceSid, body: text });
  } else {
    await client.messages.create({ to, from: fromNumber, body: text });
  }
}
