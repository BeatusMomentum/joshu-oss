/**
 * Regenerate voice-realtime instant think-ack PCM from box S2S voice config.
 * Runs scripts/generate-voice-instant-ack.sh (Gemini or OpenAI TTS → PCM24k).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function envTrim(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

export function voiceRealtimeS2sEnabled(): boolean {
  return envTrim("JOSHU_VOICE_MODE") === "realtime_s2s";
}

/** Non-fatal — logs and returns false on failure. */
export async function generateVoiceInstantAck(projectRoot = PROJECT_ROOT): Promise<boolean> {
  if (!voiceRealtimeS2sEnabled()) return false;

  const script = path.join(projectRoot, "scripts", "generate-voice-instant-ack.sh");
  return await new Promise((resolve) => {
    const child = spawn("bash", [script], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      console.warn("[joshu] voice instant ack generation spawn failed:", err.message);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        console.info("[joshu] voice instant ack PCM regenerated");
        resolve(true);
        return;
      }
      console.warn(
        `[joshu] voice instant ack generation failed (exit ${code ?? "?"}): ${stderr.trim().slice(0, 400)}`,
      );
      resolve(false);
    });
  });
}
