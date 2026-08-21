/**
 * last30days companion CLIs (watchlist.py / store.py / briefing.py).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCompanionScript, resolvePythonBin } from "./config.js";
import { buildHardenedEnv } from "./runner.js";

export type CompanionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runCompanion(
  projectRoot: string,
  scriptName: "watchlist.py" | "store.py" | "briefing.py",
  args: string[],
): Promise<CompanionResult> {
  const script = resolveCompanionScript(projectRoot, scriptName);
  if (!fs.existsSync(script)) {
    throw new Error(`Companion script missing: ${script}`);
  }
  const python = resolvePythonBin();
  const env = buildHardenedEnv(projectRoot);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], {
      cwd: path.dirname(script),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

/** Parse the last JSON object in companion stdout (scripts print one JSON blob). */
export function parseCompanionJson<T = unknown>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
