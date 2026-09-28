/**
 * Owner telephone settings (box number display, owner mobile, think passphrase).
 * Lives under the Aroz user `.joshu/` tree so voice-realtime can read the same file
 * via the shared joshu_arozos volume.
 */
import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

export type TelephoneSettings = {
  /** E.164 (e.g. +17625839074). Optional override when not in instance.env. */
  phoneNumber?: string;
  /** Spoken unlock passphrase for PSTN think/Hermes. */
  thinkPassword?: string;
  /** Owner mobile E.164 — SMS allowlist + voice owner greeting. */
  ownerCaller?: string;
  /**
   * Keypad PIN for the call gate, as a salted scrypt hash
   * (`scrypt$N$r$p$<salt b64>$<hash b64>`). The PIN itself is never stored.
   */
  pinHash?: string;
  pinLength?: number;
  /** Skip the passphrase when the owner calls from their carrier-verified number (opt-in). */
  trustVerifiedCallerId?: boolean;
};

/** Hash a keypad PIN for storage (voice-realtime verifies with the same parameters). */
export function hashTelephonePin(pin: string): string {
  const salt = randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(pin, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function settingsPath(projectRoot = process.cwd()): string | null {
  const base = joshuConfigDir(projectRoot);
  if (!base) return null;
  return path.join(base, "telephone", "settings.json");
}

function ensureDir(projectRoot: string): string | null {
  const file = settingsPath(projectRoot);
  if (!file) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

export function readTelephoneSettingsFile(projectRoot = process.cwd()): TelephoneSettings {
  const file = settingsPath(projectRoot);
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: TelephoneSettings = {};
    if (typeof parsed.phoneNumber === "string" && parsed.phoneNumber.trim()) {
      out.phoneNumber = parsed.phoneNumber.trim();
    }
    if (typeof parsed.thinkPassword === "string" && parsed.thinkPassword.trim()) {
      out.thinkPassword = parsed.thinkPassword.trim();
    }
    if (typeof parsed.ownerCaller === "string" && parsed.ownerCaller.trim()) {
      out.ownerCaller = parsed.ownerCaller.trim();
    }
    if (typeof parsed.pinHash === "string" && parsed.pinHash.startsWith("scrypt$")) {
      out.pinHash = parsed.pinHash;
      if (typeof parsed.pinLength === "number") out.pinLength = parsed.pinLength;
    }
    if (parsed.trustVerifiedCallerId === true) out.trustVerifiedCallerId = true;
    return out;
  } catch {
    return {};
  }
}

/** Settings writes; `pin` is hashed here ("" clears it). */
export type TelephoneSettingsUpdate = Omit<TelephoneSettings, "pinHash" | "pinLength"> & { pin?: string };

export function writeTelephoneSettingsFile(
  updates: TelephoneSettingsUpdate,
  projectRoot = process.cwd(),
): TelephoneSettings {
  const file = ensureDir(projectRoot);
  if (!file) throw new Error("Could not resolve telephone settings path (ArozOS user .joshu missing)");
  const current = readTelephoneSettingsFile(projectRoot);
  const next: TelephoneSettings = { ...current };

  if (updates.phoneNumber !== undefined) {
    const v = updates.phoneNumber.trim();
    if (v) next.phoneNumber = v;
    else delete next.phoneNumber;
  }
  if (updates.thinkPassword !== undefined) {
    const v = updates.thinkPassword.trim();
    if (v) next.thinkPassword = v;
    else delete next.thinkPassword;
  }
  if (updates.ownerCaller !== undefined) {
    const v = updates.ownerCaller.trim();
    if (v) next.ownerCaller = v;
    else delete next.ownerCaller;
  }
  if (updates.pin !== undefined) {
    const v = updates.pin.trim();
    if (v) {
      next.pinHash = hashTelephonePin(v);
      next.pinLength = v.length;
    } else {
      delete next.pinHash;
      delete next.pinLength;
    }
  }
  if (updates.trustVerifiedCallerId !== undefined) {
    if (updates.trustVerifiedCallerId) next.trustVerifiedCallerId = true;
    else delete next.trustVerifiedCallerId;
  }

  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
