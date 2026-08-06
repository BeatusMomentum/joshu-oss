/** Pre-rendered PCM16 mono @ 24 kHz — instant think ack (generated per box). */
import fs, { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { envTrim } from "./config.js";
import { resolveJoshuIdentity } from "./joshuIdentity.js";

const ACK_BASENAME = "instant-progress-ack.pcm.b64";

let cachedPcm: Buffer | null = null;

function repoRoot(): string {
  const pkgSrc = dirname(fileURLToPath(import.meta.url));
  return join(pkgSrc, "../../..");
}

function arozDataRoot(): string {
  return envTrim("AROZ_DATA") || join(repoRoot(), ".local", "arozos-data");
}

/** Same user pick as identity.json — box-local ack clip lives beside it. */
function boxAckClipPath(): string | null {
  const usersRoot = join(arozDataRoot(), "files", "users");
  if (!existsSync(usersRoot)) return null;

  const overrideUser = envTrim("JOSHU_AROZ_USER");
  const pickUser = (): string | null => {
    if (overrideUser) {
      const desktop = join(usersRoot, overrideUser, "Desktop");
      return existsSync(desktop) ? overrideUser : null;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "admin") continue;
      if (existsSync(join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) return ent.name;
    }
    return null;
  };

  const user = pickUser();
  if (!user) return null;
  return join(usersRoot, user, ".joshu", "voice", ACK_BASENAME);
}

function bundledAckClipPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, ACK_BASENAME),
    join(here, "..", "src", ACK_BASENAME),
    join(here, "instantProgressAck.pcm.b64"),
  ];
}

function resolveAckClipPath(): string | null {
  const explicit = envTrim("VOICE_INSTANT_ACK_PCM_PATH");
  if (explicit && existsSync(explicit)) return explicit;

  const boxPath = boxAckClipPath();
  if (boxPath && existsSync(boxPath)) return boxPath;

  for (const candidate of bundledAckClipPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** PCM16 mono @ 24 kHz for immediate think ack (no Gemini round-trip). */
export function getInstantProgressAckPcm(): Buffer | null {
  if (cachedPcm) return cachedPcm;
  const clipPath = resolveAckClipPath();
  if (!clipPath) {
    // Log once at debug — caller may fall back to Gemini progress inject.
    if (process.env.VOICE_REALTIME_DEBUG?.trim().toLowerCase() === "true") {
      console.warn(
        `[voice-realtime] instant ack PCM missing (run scripts/generate-voice-instant-ack.sh); voice=${resolveJoshuIdentity().voiceId ?? "default"}`,
      );
    }
    return null;
  }
  const b64 = readFileSync(clipPath, "utf8").replace(/\s/g, "");
  if (!b64) return null;
  cachedPcm = Buffer.from(b64, "base64");
  return cachedPcm;
}

/** Clear cache after box regenerates ack clip (e.g. voice identity sync). */
export function clearInstantProgressAckCache(): void {
  cachedPcm = null;
}
