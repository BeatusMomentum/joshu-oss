import fs from "node:fs";
import path from "node:path";

/** Persist browser handoff records under .joshu/browser-handoff/ */
export function browserHandoffDir(projectRoot = process.cwd()): string {
  return path.join(projectRoot, ".joshu", "browser-handoff");
}

export function ensureBrowserHandoffDir(projectRoot = process.cwd()): string {
  const dir = browserHandoffDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function handoffRecordPath(projectRoot: string, id: string): string {
  return path.join(browserHandoffDir(projectRoot), `${id}.json`);
}
