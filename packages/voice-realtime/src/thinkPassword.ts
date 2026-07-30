/**
 * Think-passphrase resolution for voice-realtime.
 * Prefer owner override in Aroz `.joshu/telephone/settings.json` (Telephone app),
 * then TWILIO_THINK_PASSWORD from env / instance.env.
 */
import fs from "node:fs";

import { joshuUserPath } from "./arozUserPaths.js";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function stripWrappingQuotes(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

function readOverrideThinkPassword(): string {
  const file = joshuUserPath("telephone", "settings.json");
  if (!file || !fs.existsSync(file)) return "";
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { thinkPassword?: unknown };
    if (typeof parsed.thinkPassword === "string" && parsed.thinkPassword.trim()) {
      return stripWrappingQuotes(parsed.thinkPassword);
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** Re-read on each call so Telephone app passphrase changes apply without recreate. */
export function resolveTwilioThinkPassword(): string {
  const fromFile = readOverrideThinkPassword();
  if (fromFile) return fromFile;
  return stripWrappingQuotes(envTrim("TWILIO_THINK_PASSWORD"));
}
