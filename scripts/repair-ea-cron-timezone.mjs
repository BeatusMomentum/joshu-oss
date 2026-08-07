#!/usr/bin/env node
/**
 * Repair EA cron timezone on a box: set Hermes owner IANA zone + re-upsert EA jobs.
 *
 * Usage (on box or in joshu-stack container with APP_DIR=/opt/joshu):
 *   npm run build && node scripts/repair-ea-cron-timezone.mjs
 *
 * Via Joshu API (Joshu running):
 *   curl -fsS -X POST http://127.0.0.1:8788/joshu/api/onboarding/resync-ea-crons
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resyncEaCronFromBox } = await import(
  pathToFileURL(path.join(rootDir, "dist/onboarding/resyncEaCronFromBox.js")).href
);

const result = await resyncEaCronFromBox(rootDir);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
