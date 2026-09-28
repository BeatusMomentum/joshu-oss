/**
 * Telephone settings the gate reads, straight from the owner's
 * `.joshu/telephone/settings.json` (written by Joshu's Telephone app) — re-read
 * per request so changes apply to the next call without a restart.
 */
import fs from "node:fs";

import { joshuUserPath } from "../arozUserPaths.js";
import { resolveTwilioThinkPassword } from "../thinkPassword.js";

export type GateSettings = {
  passphrase: string;
  /** scrypt hash of the keypad PIN, when one is set. */
  pinHash?: string;
  pinLength?: number;
  /** Owner opted in to skipping the passphrase from their carrier-verified number. */
  trustVerifiedCallerId: boolean;
  /** Owner mobile, digits and leading + only. */
  ownerCaller: string;
};

export function normalizePhone(raw: string | undefined): string {
  return (raw ?? "").replace(/[^\d+]/g, "");
}

/** Same number, tolerant of a missing +1 on US numbers. */
export function samePhone(a: string | undefined, b: string | undefined): boolean {
  const canon = (raw: string | undefined) => {
    const digits = (raw ?? "").replace(/\D/g, "");
    return digits.length === 10 ? `1${digits}` : digits;
  };
  const ca = canon(a);
  return ca.length >= 8 && ca === canon(b);
}

function readSettingsFile(): Record<string, unknown> {
  const file = joshuUserPath("telephone", "settings.json");
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readGateSettings(): GateSettings {
  const file = readSettingsFile();
  const pinHash = typeof file.pinHash === "string" && file.pinHash.startsWith("scrypt$") ? file.pinHash : undefined;
  const pinLength =
    typeof file.pinLength === "number" && file.pinLength >= 4 && file.pinLength <= 8 ? file.pinLength : undefined;
  const ownerRaw =
    typeof file.ownerCaller === "string" && file.ownerCaller.trim()
      ? file.ownerCaller
      : process.env.TWILIO_OWNER_CALLER ?? "";
  return {
    passphrase: resolveTwilioThinkPassword(),
    ...(pinHash && pinLength ? { pinHash, pinLength } : {}),
    trustVerifiedCallerId: file.trustVerifiedCallerId === true,
    ownerCaller: normalizePhone(ownerRaw),
  };
}
