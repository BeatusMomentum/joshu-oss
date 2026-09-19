#!/usr/bin/env node
/**
 * Daily onboarding reconcile — direct import, no HTTP.
 * Hermes cron (no_agent) runs this via onboarding-reconcile.sh.
 * Uses compiled dist on boxes; falls back to src when tsx is available (dev).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distModule = join(__dirname, "../dist/onboarding/reconcileOnboardingBoard.js");
const importPath = existsSync(distModule)
  ? "../dist/onboarding/reconcileOnboardingBoard.js"
  : "../src/onboarding/reconcileOnboardingBoard.js";

const { reconcileOnboardingBoard } = await import(importPath);

const projectRoot = process.env.JOSHU_PROJECT_ROOT?.trim() || process.cwd();
const result = await reconcileOnboardingBoard(projectRoot);

if (!result.ok) {
  console.error(`[onboarding] reconcile failed: ${result.error ?? "unknown"}`);
  process.exit(1);
}

if (result.completeFailed > 0) {
  const failed = result.prompts.filter((p) => p.status === "complete_failed");
  for (const row of failed) {
    console.error(
      `[onboarding] reconcile complete failed prompt=${row.id} task=${row.taskId ?? "?"}: ${row.error ?? "unknown"}`,
    );
  }
}

console.info(
  `[onboarding] reconcile ${result.ok ? "ok" : "partial"} created=${result.created} completed=${result.completed} completeFailed=${result.completeFailed} open=${result.open}`,
);
process.exit(result.ok ? 0 : 1);
