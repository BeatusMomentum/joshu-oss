/**
 * CLI wrapper for lock prompt clip rendering — voice-realtime does this on
 * startup, so this is for forcing a re-render or generating out of band.
 *
 *   node dist/generateLockPromptClipsCli.js [--force]
 */
import "./loadEnv.js";

import { ensureLockPromptClips } from "./generateLockPromptClips.js";

ensureLockPromptClips(process.argv.includes("--force")).catch((err: unknown) => {
  console.error(`[lock-prompts] ${(err as Error).message}`);
  process.exit(1);
});
