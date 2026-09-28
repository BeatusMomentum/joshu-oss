/**
 * Render a fixed line with the Gemini Live model itself, so gate clips sound
 * like the voice the caller hears a second later (standalone TTS models use the
 * same voice names but sound noticeably different).
 *
 * Live models are conversational and may paraphrase, so every render comes
 * back with the model's own output transcription; the caller checks it against
 * the script and retries.
 */
import WebSocket from "ws";

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Framing matters: handed the bare line ("Hi. Please say your passphrase."),
 * 3.8 Live answers it ("I don't have a passphrase"); as a labelled script it
 * reads it verbatim (9/9 on both 3.8 Live models, 2026-09-27).
 */
const RECORDER_INSTRUCTION = "You read scripts aloud for recordings. Output only the spoken script.";

function scriptTurn(line: string): string {
  return `Read the following script aloud, word for word, including the first word. Do not reply to it.\n\nSCRIPT:\n${line}`;
}

export type LiveRender = { pcm24k: Buffer; transcript: string };

export function renderLineWithGeminiLive(
  text: string,
  options: { apiKey: string; model: string; voice: string; timeoutMs?: number },
): Promise<LiveRender> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${GEMINI_WS_URL}?key=${encodeURIComponent(options.apiKey)}`);
    const chunks: Buffer[] = [];
    let transcript = "";
    let settled = false;
    /** 3.8 Live keeps streaming audio after turnComplete; finish once it goes quiet. */
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let turnDone = false;
    const settleWhenQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), 1_500);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
      socket.close();
      if (error) reject(error);
      else resolve({ pcm24k: Buffer.concat(chunks), transcript: transcript.replace(/<no speech>/gi, "").trim() });
    };
    const timer = setTimeout(() => finish(new Error("Gemini Live render timed out")), options.timeoutMs ?? 30_000);

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${options.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
              ...(/extended-thinking/.test(options.model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
            },
            systemInstruction: { parts: [{ text: RECORDER_INSTRUCTION }] },
            outputAudioTranscription: {},
          },
        }),
      );
    });
    socket.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.setupComplete != null) {
        socket.send(
          JSON.stringify({
            clientContent: { turns: [{ role: "user", parts: [{ text: scriptTurn(text) }] }], turnComplete: true },
          }),
        );
        return;
      }
      if (msg.error) {
        finish(new Error(String((msg.error as Record<string, unknown>).message ?? "Gemini Live error")));
        return;
      }
      const sc = msg.serverContent as Record<string, unknown> | undefined;
      if (!sc) return;
      const out = sc.outputTranscription as { text?: string } | undefined;
      if (typeof out?.text === "string") transcript += out.text;
      const parts = ((sc.modelTurn as { parts?: unknown[] } | undefined)?.parts ?? []) as Array<{
        inlineData?: { data?: string };
      }>;
      for (const part of parts) {
        if (part.inlineData?.data) {
          chunks.push(Buffer.from(part.inlineData.data, "base64"));
          if (turnDone) settleWhenQuiet();
        }
      }
      if (sc.turnComplete === true) {
        turnDone = true;
        settleWhenQuiet();
      }
    });
    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => finish(new Error("Gemini Live closed before the line finished")));
  });
}

/**
 * Letters and digits only — what "said exactly the line" is compared on. Spaces
 * are dropped too: Live transcripts sometimes run words together ("updatefor").
 */
export function spokenWords(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Drop leading/trailing silence (keeps a short margin) from PCM16 mono @ 24 kHz. */
export function trimSilence(pcm: Buffer, threshold = 400, marginMs = 80): Buffer {
  const aligned = pcm.subarray(0, pcm.length - (pcm.length % 2));
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
  const win = 240; // 10 ms
  const loud = (start: number) => {
    let sum = 0;
    const end = Math.min(start + win, samples.length);
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    return Math.sqrt(sum / Math.max(1, end - start)) > threshold;
  };
  let first = 0;
  while (first < samples.length && !loud(first)) first += win;
  let last = samples.length - win;
  while (last > first && !loud(last)) last -= win;
  if (first >= samples.length) return aligned;
  const margin = Math.round((marginMs / 1000) * 24000);
  const from = Math.max(0, first - margin);
  const to = Math.min(samples.length, last + win + margin);
  return Buffer.from(aligned.subarray(from * 2, to * 2));
}
