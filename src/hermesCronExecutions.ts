/**
 * Lightweight probe for in-flight Hermes cron executions.
 * Used to avoid replacing the gateway mid-run (kills the cron agent session).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const COUNT_ACTIVE_SQL = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute(
  "SELECT COUNT(*) FROM executions WHERE finished_at IS NULL"
).fetchone()
print(row[0] if row else 0)
`.trim();

/** True when Hermes cron has at least one execution without finished_at. */
export async function countActiveCronExecutions(hermesHome: string): Promise<number> {
  const dbPath = path.join(hermesHome, "cron", "executions.db");
  if (!existsSync(dbPath)) return 0;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", COUNT_ACTIVE_SQL, dbPath], {
      timeout: 3_000,
      encoding: "utf8",
    });
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function hasActiveCronExecutions(hermesHome: string): Promise<boolean> {
  return (await countActiveCronExecutions(hermesHome)) > 0;
}
