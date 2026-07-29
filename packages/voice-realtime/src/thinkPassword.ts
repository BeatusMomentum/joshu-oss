/**
 * Think-passphrase resolution for voice-realtime.
 * Prefer owner override in Aroz `.joshu/telephone/settings.json` (Telephone app),
 * then TWILIO_THINK_PASSWORD from env / instance.env.
 */
import fs from "node:fs";
import path from "node:path";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function stripWrappingQuotes(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

function pickArozUser(usersRoot: string): string | null {
  const overrideUser = envTrim("JOSHU_AROZ_USER");
  if (overrideUser) {
    const desktop = path.join(usersRoot, overrideUser, "Desktop");
    return fs.existsSync(desktop) ? overrideUser : null;
  }
  try {
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "admin") continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
  } catch {
    return null;
  }
  return null;
}

function telephoneSettingsPath(): string | null {
  const arozData = envTrim("AROZ_DATA") || "/var/lib/arozos";
  const usersRoot = path.join(arozData, "files", "users");
  if (!fs.existsSync(usersRoot)) return null;
  const user = pickArozUser(usersRoot);
  if (!user) return null;
  return path.join(usersRoot, user, ".joshu", "telephone", "settings.json");
}

function readOverrideThinkPassword(): string {
  const file = telephoneSettingsPath();
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
