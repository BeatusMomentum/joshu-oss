/**
 * Gate lines as WAV files Twilio can <Play>. Same pre-rendered clips as the
 * in-stream lock (lockPrompts.ts), converted to PCM16 mono @ 8 kHz. URLs carry
 * a content version so Twilio's media cache picks up a re-render. A missing
 * clip falls back to <Say> with the same text (Twilio's voice, exact words).
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { resamplePcm16 } from "../audioResample.js";
import { LOCK_PROMPTS, lockPromptDir, readLockPromptPcm24k, type LockPromptKey } from "../lockPrompts.js";
import type { TwimlNode } from "./twiml.js";

type CachedWav = { version: string; wav: Buffer };
const cache = new Map<LockPromptKey, CachedWav>();

function fileStamp(key: LockPromptKey): string | null {
  try {
    const stat = statSync(join(lockPromptDir(), `${key}.pcm.b64`));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

export function wavFromPcm16(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The clip as an 8 kHz WAV plus its content version, or null when not rendered. */
export function gateClipWav(key: LockPromptKey): CachedWav | null {
  const stamp = fileStamp(key);
  if (!stamp) return null;
  const version = createHash("sha1").update(`${LOCK_PROMPTS[key]}|${stamp}`).digest("hex").slice(0, 12);
  const cached = cache.get(key);
  if (cached?.version === version) return cached;
  const pcm = readLockPromptPcm24k(key);
  if (!pcm) return null;
  const aligned = pcm.subarray(0, pcm.length - (pcm.length % 2));
  const samples24k = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
  const entry = { version, wav: wavFromPcm16(resamplePcm16(samples24k, 24000, 8000), 8000) };
  cache.set(key, entry);
  return entry;
}

export function isGateClipKey(key: string): key is LockPromptKey {
  return Object.prototype.hasOwnProperty.call(LOCK_PROMPTS, key);
}

/** `<Play>` of the rendered clip, or `<Say>` of its exact text when it is missing. */
export function speakClip(key: LockPromptKey, gateBaseUrl: string): TwimlNode {
  const clip = gateClipWav(key);
  if (clip) return { verb: "Play", text: `${gateBaseUrl}/clips/${key}.wav?v=${clip.version}` };
  return { verb: "Say", text: LOCK_PROMPTS[key] };
}
