import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCK_PROMPTS,
  LOCK_PROMPT_KEYS,
  clearLockPromptCache,
  getLockPromptClip,
  lockPromptsReady,
} from "../dist/lockPrompts.js";

/** One second of silent PCM16 mono @ 24 kHz, base64 — what the generator writes. */
function oneSecondClipB64() {
  return Buffer.alloc(24000 * 2).toString("base64");
}

function stageClips(keys) {
  const dir = mkdtempSync(join(tmpdir(), "joshu-lock-prompts-"));
  for (const key of keys) {
    writeFileSync(join(dir, `${key}.pcm.b64`), `${oneSecondClipB64()}\n`, "utf8");
  }
  process.env.VOICE_LOCK_PROMPT_DIR = dir;
  clearLockPromptCache();
  return dir;
}

test("every lock prompt has non-empty text the generator can render", () => {
  assert.ok(LOCK_PROMPT_KEYS.length > 0);
  for (const key of LOCK_PROMPT_KEYS) {
    assert.equal(typeof LOCK_PROMPTS[key], "string");
    assert.ok(LOCK_PROMPTS[key].trim().length > 0, `${key} has no text`);
  }
});

test("the rejection line never implies the caller was let in", () => {
  // Regression: Gemini voiced a rejection as "Unlocked. What…", so the caller
  // kept talking to a locked line. Clips must state the refusal plainly.
  assert.match(LOCK_PROMPTS.retry, /not the passphrase/i);
  assert.doesNotMatch(LOCK_PROMPTS.retry, /unlocked/i);
  assert.doesNotMatch(LOCK_PROMPTS.last_try, /unlocked/i);
});

test("clips resolve to Twilio-ready mu-law with the right duration", () => {
  const dir = stageClips(LOCK_PROMPT_KEYS);
  try {
    const clip = getLockPromptClip("retry");
    assert.ok(clip, "expected a clip");
    // 24 kHz PCM16 downsampled to 8 kHz mu-law is one byte per sample.
    assert.equal(Buffer.byteLength(clip.mulawB64, "base64"), 8000);
    assert.equal(clip.durationMs, 1000);
    assert.equal(lockPromptsReady(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VOICE_LOCK_PROMPT_DIR;
    clearLockPromptCache();
  }
});

test("a partial clip set stays on the model path rather than risk silence", () => {
  const dir = stageClips(LOCK_PROMPT_KEYS.filter((key) => key !== "time_up"));
  try {
    assert.equal(lockPromptsReady(), false);
    assert.equal(getLockPromptClip("time_up"), null);
    assert.ok(getLockPromptClip("retry"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VOICE_LOCK_PROMPT_DIR;
    clearLockPromptCache();
  }
});
