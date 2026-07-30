/**
 * Render the fixed lock lines to audio in this box's own Joshu voice.
 *
 * Locked calls are voiced by these clips rather than by the speech-to-speech
 * model, which paraphrases (see lockPrompts.ts). voice-realtime calls this on
 * startup so a fresh clip volume heals itself; it is also runnable directly:
 *
 *   node dist/generateLockPromptClipsCli.js [--force]
 *
 * Output is PCM16 mono @ 24 kHz base64, one file per prompt key. A manifest
 * records the voice and text each clip came from, so a re-run only
 * re-synthesizes what actually changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resamplePcm16 } from "./audioResample.js";
import {
  envTrim,
  GEMINI_LIVE_VOICE,
  OPENAI_API_KEY,
  OPENAI_REALTIME_VOICE,
  resolveGeminiApiKey,
  VOICE_S2S_PROVIDER,
} from "./config.js";
import {
  clearLockPromptCache,
  LOCK_PROMPTS,
  LOCK_PROMPT_KEYS,
  lockPromptDir,
  type LockPromptKey,
} from "./lockPrompts.js";

const MANIFEST_BASENAME = "clips.json";
const TARGET_SAMPLE_RATE = 24000;

/** OpenAI's TTS voices differ from its realtime voices; fall back rather than fail. */
const OPENAI_TTS_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);

type Manifest = {
  provider: string;
  voice: string;
  prompts: Partial<Record<LockPromptKey, string>>;
};

function log(message: string): void {
  console.info(`[lock-prompts] ${message}`);
}

function readManifest(dir: string): Manifest | null {
  const file = join(dir, MANIFEST_BASENAME);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Extract PCM16 from a synthesis response. OpenAI returns raw PCM at 24 kHz;
 * Gemini returns either raw PCM or a WAV, whose rate we honour.
 */
function toPcm24k(raw: Buffer): Buffer {
  if (raw.length < 12 || raw.subarray(0, 4).toString("ascii") !== "RIFF") {
    return raw.subarray(0, raw.length - (raw.length % 2));
  }

  let sampleRate = TARGET_SAMPLE_RATE;
  let offset = 12;
  let data: Buffer | null = null;
  while (offset + 8 <= raw.length) {
    const chunkId = raw.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = raw.readUInt32LE(offset + 4);
    const body = raw.subarray(offset + 8, Math.min(offset + 8 + chunkSize, raw.length));
    if (chunkId === "fmt " && body.length >= 8) sampleRate = body.readUInt32LE(4);
    if (chunkId === "data") data = body;
    // Chunks are word-aligned.
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!data) throw new Error("WAV response had no data chunk");

  const aligned = data.subarray(0, data.length - (data.length % 2));
  if (sampleRate === TARGET_SAMPLE_RATE) return aligned;

  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
  const resampled = resamplePcm16(samples, sampleRate, TARGET_SAMPLE_RATE);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

async function synthesizeGemini(text: string, voice: string): Promise<Buffer> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY required for JOSHU_VOICE_PROVIDER=gemini_live");
  const model = envTrim("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts");
  // Several lock lines are questions or instructions; handed over bare, the TTS
  // model tries to answer them and the request fails. The style prefix before
  // the colon is direction, not script — it is not spoken.
  const prompt = `Read this aloud in a calm, clear, friendly voice: ${text}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini TTS HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  const payload = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
  };
  const inline = payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
  if (!inline?.inlineData?.data) throw new Error("Gemini TTS response had no inline audio");
  return Buffer.from(inline.inlineData.data, "base64");
}

async function synthesizeOpenai(text: string, voice: string): Promise<Buffer> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for the openai voice provider");
  const requested = voice.toLowerCase();
  const resolved = OPENAI_TTS_VOICES.has(requested) ? requested : "alloy";
  if (resolved !== requested) log(`OpenAI TTS has no voice "${voice}" — using ${resolved}`);

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: envTrim("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
      input: text,
      voice: resolved,
      response_format: "pcm",
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Make sure every lock clip on disk matches the current voice and text.
 * Returns how many were re-synthesized.
 */
export async function ensureLockPromptClips(force = false): Promise<number> {
  const gemini = VOICE_S2S_PROVIDER === "gemini_live";
  const voice = gemini ? GEMINI_LIVE_VOICE : OPENAI_REALTIME_VOICE;
  const dir = lockPromptDir();
  mkdirSync(dir, { recursive: true });

  const previous = readManifest(dir);
  // A voice change invalidates every clip; a text change invalidates just one.
  const voiceChanged = previous?.voice !== voice || previous?.provider !== VOICE_S2S_PROVIDER;
  const manifest: Manifest = { provider: VOICE_S2S_PROVIDER, voice, prompts: {} };

  log(`provider=${VOICE_S2S_PROVIDER} voice=${voice} dir=${dir}`);

  let rendered = 0;
  for (const key of LOCK_PROMPT_KEYS) {
    const text = LOCK_PROMPTS[key];
    const clipFile = join(dir, `${key}.pcm.b64`);
    const fresh =
      !force && !voiceChanged && previous?.prompts?.[key] === text && existsSync(clipFile);
    if (fresh) {
      manifest.prompts[key] = text;
      continue;
    }

    const raw = gemini ? await synthesizeGemini(text, voice) : await synthesizeOpenai(text, voice);
    const pcm = toPcm24k(raw);
    if (pcm.length < 2000) throw new Error(`${key}: synthesized audio too short (${pcm.length}B)`);
    writeFileSync(clipFile, `${pcm.toString("base64")}\n`, "utf8");
    manifest.prompts[key] = text;
    rendered += 1;
    log(`rendered ${key} (${Math.round((pcm.length / 2 / TARGET_SAMPLE_RATE) * 1000)}ms)`);
  }

  writeFileSync(join(dir, MANIFEST_BASENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(rendered ? `done — ${rendered} clip(s) rendered` : "done — all clips already current");
  if (rendered > 0) clearLockPromptCache();
  return rendered;
}
