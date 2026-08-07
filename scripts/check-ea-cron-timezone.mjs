#!/usr/bin/env node
/**
 * Unit smoke: syncHermesOwnerTimezone writes config.yaml + .env.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { syncHermesOwnerTimezone } = await import(
  pathToFileURL(path.join(rootDir, "dist/hermesOwnerTimezone.js")).href
);

const tmp = await mkdtemp(path.join(os.tmpdir(), "joshu-hermes-tz-"));
process.env.HERMES_HOME = tmp;

try {
  const first = await syncHermesOwnerTimezone("America/Los_Angeles");
  if (!first.ok || !first.changed) {
    console.error("FAIL: expected first sync to succeed and change config", first);
    process.exit(1);
  }

  const config = await readFile(path.join(tmp, "config.yaml"), "utf8");
  if (!config.includes("timezone: America/Los_Angeles")) {
    console.error("FAIL: config.yaml missing timezone", config);
    process.exit(1);
  }

  const dotenv = await readFile(path.join(tmp, ".env"), "utf8");
  if (!dotenv.includes("HERMES_TIMEZONE=America/Los_Angeles")) {
    console.error("FAIL: .env missing HERMES_TIMEZONE", dotenv);
    process.exit(1);
  }

  const second = await syncHermesOwnerTimezone("America/Los_Angeles");
  if (!second.ok || second.changed) {
    console.error("FAIL: second sync should be idempotent", second);
    process.exit(1);
  }

  console.log("OK: Hermes owner timezone sync");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
