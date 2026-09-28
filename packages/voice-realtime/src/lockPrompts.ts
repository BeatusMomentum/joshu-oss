/**
 * Deterministic spoken lines for the call gate (Twilio <Gather>, before any
 * model joins the call — see gate/routes.ts).
 *
 * These lines must say exactly what they say: they carry the security story, so
 * a paraphrase is a correctness bug, not a style one. Each line is pre-rendered
 * to audio in the box's own Joshu voice (generateLockPromptClips.ts, run at
 * service start) and served to Twilio as WAV; a missing clip falls back to
 * Twilio <Say> with the same words.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pcm24kB64ToMulaw8kB64 } from "./audioResample.js";
import { resolveJoshuIdentity } from "./joshuIdentity.js";

const assistantName = resolveJoshuIdentity().name;

/** Every gate line. The generator renders exactly this text. */
export const LOCK_PROMPTS = {
  greeting: "Hi. Please say your passphrase.",
  greeting_pin: "Hi. Say your passphrase, or enter your PIN.",
  callback_greeting: `Hi, it's ${assistantName} with an update for you. Please say your passphrase.`,
  callback_greeting_pin: `Hi, it's ${assistantName} with an update for you. Say your passphrase, or enter your PIN.`,
  unclear: "Sorry, I didn't catch that. Please say your passphrase.",
  unclear_pin: "Sorry, I didn't catch that. Say your passphrase, or enter your PIN.",
  retry: "That didn't match. Please try again.",
  last_try: "That didn't match. One try left.",
  locked_out: "Too many incorrect attempts. Goodbye.",
  // The opener that follows greets the owner — this line only confirms the unlock.
  unlocked: "Unlocked.",
  voicemail_notice: `Hi, it's ${assistantName}. I have an update for you, and I've sent the details by text.`,
} as const;

export type LockPromptKey = keyof typeof LOCK_PROMPTS;

export const LOCK_PROMPT_KEYS = Object.keys(LOCK_PROMPTS) as LockPromptKey[];

/** Twilio Media Streams play μ-law 8 kHz, so one byte is one sample. */
const MULAW_BYTES_PER_SECOND = 8000;

export type LockPromptClip = {
  /** μ-law 8 kHz, base64 — ready to hand to Twilio as `media.payload`. */
  mulawB64: string;
  /** Playback length, for scheduling a hang-up after the clip drains. */
  durationMs: number;
};

const cache = new Map<LockPromptKey, LockPromptClip | null>();

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Clips are voice-realtime's own derived cache, not owner data, and the service
 * mounts the ArozOS volume read-only — so they live in a directory it owns. In
 * the container that is a small dedicated volume; in local dev it falls back
 * inside the package.
 */
export function lockPromptDir(): string {
  const explicit = envTrim("VOICE_LOCK_PROMPT_DIR");
  if (explicit) return explicit;
  if (existsSync("/var/lib/joshu-voice")) return "/var/lib/joshu-voice/lock";
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "lock-prompts");
}

function clipPath(key: LockPromptKey): string {
  return join(lockPromptDir(), `${key}.pcm.b64`);
}

/** Generated as PCM16 mono @ 24 kHz (same format as the rest of the voice clips). */
function loadClip(key: LockPromptKey): LockPromptClip | null {
  const path = clipPath(key);
  if (!existsSync(path)) return null;
  try {
    const pcmB64 = readFileSync(path, "utf8").replace(/\s/g, "");
    if (!pcmB64) return null;
    const mulawB64 = pcm24kB64ToMulaw8kB64(pcmB64);
    if (!mulawB64) return null;
    const bytes = Buffer.byteLength(mulawB64, "base64");
    return { mulawB64, durationMs: Math.round((bytes / MULAW_BYTES_PER_SECOND) * 1000) };
  } catch {
    return null;
  }
}

/** The clip as PCM16 mono @ 24 kHz (what the generator wrote), or null. */
export function readLockPromptPcm24k(key: LockPromptKey): Buffer | null {
  const path = clipPath(key);
  if (!existsSync(path)) return null;
  try {
    const pcm = Buffer.from(readFileSync(path, "utf8").replace(/\s/g, ""), "base64");
    return pcm.length >= 2 ? pcm : null;
  } catch {
    return null;
  }
}

/** Cached per process — clips only change when the box regenerates them. */
export function getLockPromptClip(key: LockPromptKey): LockPromptClip | null {
  if (!cache.has(key)) cache.set(key, loadClip(key));
  return cache.get(key) ?? null;
}

/** Clear cache after the box regenerates clips (e.g. voice identity change). */
export function clearLockPromptCache(): void {
  cache.clear();
}
