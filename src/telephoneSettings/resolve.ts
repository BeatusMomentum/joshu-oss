/**
 * Resolve PSTN phone number + think passphrase for the Telephone app and Twilio gateway.
 * Precedence: `.joshu/telephone/settings.json` → `/etc/joshu/instance.env` → process.env.
 */
import { provisionEnvTrim } from "../provisionInstanceEnv.js";
import { readTelephoneSettingsFile } from "./store.js";

function stripWrappingQuotes(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

/** Normalize to digits + leading + for display / comparison. */
export function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus || digits.length > 10 ? `+${digits}` : digits;
}

export function formatPhoneDisplay(e164: string): string {
  const n = normalizeE164(e164);
  // US/CA: +1 NXX NXX XXXX
  const m = n.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  return n || e164.trim();
}

export function resolveThinkPassword(projectRoot = process.cwd()): string {
  const fromFile = readTelephoneSettingsFile(projectRoot).thinkPassword;
  if (fromFile) return stripWrappingQuotes(fromFile);
  const fromProvision = provisionEnvTrim("TWILIO_THINK_PASSWORD");
  if (fromProvision) return stripWrappingQuotes(fromProvision);
  return stripWrappingQuotes(process.env.TWILIO_THINK_PASSWORD?.trim() ?? "");
}

export function resolvePhoneNumber(projectRoot = process.cwd()): string {
  const fromFile = readTelephoneSettingsFile(projectRoot).phoneNumber;
  if (fromFile) return normalizeE164(fromFile);
  for (const key of ["TWILIO_PHONE_NUMBER", "TWILIO_CALLER_ID", "JOSHU_PHONE_NUMBER"] as const) {
    const v = provisionEnvTrim(key) || process.env[key]?.trim();
    if (v) return normalizeE164(v);
  }
  return "";
}

export type TelephoneStatus = {
  phoneNumber: string;
  phoneNumberDisplay: string;
  thinkPassword: string;
  thinkPasswordConfigured: boolean;
  pstnEnabled: boolean;
  sources: {
    phoneNumber: "settings-file" | "env" | "unset";
    thinkPassword: "settings-file" | "env" | "unset";
  };
};

export function readTelephoneStatus(projectRoot = process.cwd()): TelephoneStatus {
  const file = readTelephoneSettingsFile(projectRoot);
  const phoneNumber = resolvePhoneNumber(projectRoot);
  const thinkPassword = resolveThinkPassword(projectRoot);
  const phoneSource: TelephoneStatus["sources"]["phoneNumber"] = file.phoneNumber
    ? "settings-file"
    : phoneNumber
      ? "env"
      : "unset";
  const passSource: TelephoneStatus["sources"]["thinkPassword"] = file.thinkPassword
    ? "settings-file"
    : thinkPassword
      ? "env"
      : "unset";

  const auth = (provisionEnvTrim("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN?.trim() || "").length > 0;
  const media = (
    provisionEnvTrim("TWILIO_MEDIA_STREAM_SECRET") ||
    process.env.TWILIO_MEDIA_STREAM_SECRET?.trim() ||
    ""
  ).length > 0;
  const webhook = (
    provisionEnvTrim("TWILIO_VOICE_WEBHOOK_URL") ||
    process.env.TWILIO_VOICE_WEBHOOK_URL?.trim() ||
    ""
  ).length > 0;

  return {
    phoneNumber,
    phoneNumberDisplay: phoneNumber ? formatPhoneDisplay(phoneNumber) : "",
    thinkPassword,
    thinkPasswordConfigured: Boolean(thinkPassword),
    pstnEnabled: Boolean(auth && media && webhook && thinkPassword),
    sources: { phoneNumber: phoneSource, thinkPassword: passSource },
  };
}
