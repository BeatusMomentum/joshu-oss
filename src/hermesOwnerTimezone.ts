/**
 * Align Hermes cron timezone with the box owner's IANA zone.
 * Hermes interprets cron hour/minute in config.yaml `timezone` (or HERMES_TIMEZONE).
 * Without this, VPS boxes (UTC) fire EA jobs at UTC wall clock instead of owner local time.
 */
import { homedir } from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { isValidIanaTimezone, normalizeIanaTimezone } from "./ianaTimezone.js";
import { readManagedHermesConfig, writeMergedHermesConfig } from "./hermesConfigSplit.js";

function getHermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/** Shell-safe .env value (mirrors hermesApi.formatHermesDotenvValue). */
function formatDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Keep HERMES_TIMEZONE in ~/.hermes/.env aligned (highest priority for Hermes cron). */
async function syncHermesTimezoneDotenv(timezone: string): Promise<boolean> {
  const envPath = path.join(getHermesHome(), ".env");
  const key = "HERMES_TIMEZONE";
  const next = `${key}=${formatDotenvValue(timezone)}`;
  let lines: string[] = [];
  try {
    lines = (await readFile(envPath, "utf8")).split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const idx = lines.findIndex((line) => line === next || line.startsWith(`${key}=`));
  if (idx >= 0) {
    if (lines[idx] === next) return false;
    lines[idx] = next;
  } else {
    lines.push(next);
  }
  const body = lines.join("\n").replace(/\n*$/, "\n");
  await writeFile(envPath, body, "utf8");
  return true;
}

export type SyncHermesOwnerTimezoneResult = {
  ok: boolean;
  changed: boolean;
  timezone?: string;
  error?: string;
};

/**
 * Write owner IANA timezone into managed Hermes config + .env.
 * Idempotent when already set to the same zone.
 */
export async function syncHermesOwnerTimezone(
  timezone: string | undefined,
): Promise<SyncHermesOwnerTimezoneResult> {
  const raw = timezone?.trim();
  if (!raw) {
    return { ok: false, changed: false, error: "timezone is required" };
  }
  const normalized = normalizeIanaTimezone(raw);
  if (!isValidIanaTimezone(normalized)) {
    return { ok: false, changed: false, error: `invalid IANA timezone "${raw}"` };
  }

  try {
    const hermesHome = getHermesHome();
    const { managed } = await readManagedHermesConfig(hermesHome);
    const config = { ...managed };
    const previous = typeof config.timezone === "string" ? config.timezone.trim() : "";
    const configChanged = previous !== normalized;
    if (configChanged) {
      config.timezone = normalized;
      await writeMergedHermesConfig(hermesHome, config);
    }
    const dotenvChanged = await syncHermesTimezoneDotenv(normalized);
    const changed = configChanged || dotenvChanged;
    if (changed) {
      console.info(`[hermes-timezone] synced owner timezone ${normalized} (Hermes cron + clock)`);
    }
    return { ok: true, changed, timezone: normalized };
  } catch (err) {
    return { ok: false, changed: false, error: (err as Error).message };
  }
}
