/**
 * Render the fixed call-gate lines to audio in this box's own Joshu voice.
 *
 * The gate is voiced by these clips rather than by the speech-to-speech model
 * live, which paraphrases (see lockPrompts.ts). Gemini boxes render them with the
 * Live model itself so they sound like the call that follows. voice-realtime calls this on
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
  GEMINI_LIVE_MODEL,
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
import { renderLineWithGeminiLive, spokenWords, trimSilence } from "./liveClipRenderer.js";

/** Live renders per line before falling back to the standalone TTS model. */
const LIVE_RENDER_ATTEMPTS = 4;

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
  /** Model the clips came from, e.g. `live:gemini-3.8-live` (a change re-renders every clip). */
  model?: string;
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

/** Gemini TTS model for the gate clips (same generation as the live voice model). */
function geminiTtsModel(): string {
  return envTrim("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts");
}

function openaiTtsModel(): string {
  return envTrim("OPENAI_TTS_MODEL", "gpt-4o-mini-tts");
}

async function synthesizeGemini(text: string, voice: string): Promise<Buffer> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY required for JOSHU_VOICE_PROVIDER=gemini_live");
  const model = geminiTtsModel();
  // 2.5 TTS tried to *answer* bare instructions ("Please say your passphrase"),
  // so it got a style prefix it treated as direction. 3.x TTS reads bare lines
  // verbatim — and reads any prefix aloud — so it gets exactly the line.
  const prompt = /^gemini-2\./.test(model) ? `Read this aloud in a calm, clear, friendly voice: ${text}` : text;

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

/**
 * Gemini: render with the Live model the calls use, so the clip sounds like
 * the voice that follows it. Keep a render only when the model's own
 * transcript is the line word for word; otherwise retry, then fall back to
 * the standalone TTS model (right words, slightly different voice).
 */
async function synthesizeGeminiClip(key: LockPromptKey, text: string, voice: string): Promise<Buffer> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY required for JOSHU_VOICE_PROVIDER=gemini_live");
  const want = spokenWords(text);
  for (let attempt = 1; attempt <= LIVE_RENDER_ATTEMPTS; attempt += 1) {
    try {
      const render = await renderLineWithGeminiLive(text, { apiKey, model: GEMINI_LIVE_MODEL, voice });
      if (spokenWords(render.transcript) === want && render.pcm24k.length >= 2000) {
        return trimSilence(render.pcm24k);
      }
      log(`${key}: live render ${attempt} said ${JSON.stringify(render.transcript)} — retrying`);
    } catch (error) {
      log(`${key}: live render ${attempt} failed (${(error as Error).message})`);
    }
  }
  log(`${key}: no verbatim live render — using ${geminiTtsModel()}`);
  return toPcm24k(await synthesizeGemini(text, voice));
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
      model: openaiTtsModel(),
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

  const model = gemini ? `live:${GEMINI_LIVE_MODEL}` : openaiTtsModel();
  const previous = readManifest(dir);
  // A voice or model change invalidates every clip; a text change invalidates just one.
  const voiceChanged =
    previous?.voice !== voice || previous?.provider !== VOICE_S2S_PROVIDER || previous?.model !== model;
  const manifest: Manifest = { provider: VOICE_S2S_PROVIDER, voice, model, prompts: {} };

  log(`provider=${VOICE_S2S_PROVIDER} voice=${voice} model=${model} dir=${dir}`);

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

    const pcm = gemini
      ? await synthesizeGeminiClip(key, text, voice)
      : toPcm24k(await synthesizeOpenai(text, voice));
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
