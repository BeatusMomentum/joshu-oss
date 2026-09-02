import assert from "node:assert/strict";
import test from "node:test";

import {
  isPassphraseOnlyTurn,
  looksLikePhoneTaskRequest,
  matchesThinkPassphrase,
} from "../dist/phonePassphrase.js";

test("fuzzy match accepts STT drift around a two-word passphrase", () => {
  const secret = "Falken's Maze";
  assert.equal(matchesThinkPassphrase("Falken's Maze", secret), true);
  assert.equal(matchesThinkPassphrase("Falcon's Maze", secret), true);
  assert.equal(matchesThinkPassphrase("falkens maze", secret), true);
  assert.equal(matchesThinkPassphrase("hello there", secret), false);
});

test("phonetic match accepts quartz heard as courts (PSTN STT)", () => {
  const secret = "quartz citadel";
  assert.equal(matchesThinkPassphrase("Courts Citadel", secret), true);
  assert.equal(matchesThinkPassphrase("quartz citadel", secret), true);
  assert.equal(matchesThinkPassphrase("harbor lantern", secret), false);
});

test("passphrase-only turns are not task requests", () => {
  const secret = "Falken's Maze";
  assert.equal(isPassphraseOnlyTurn("Falcon's Maze", secret), true);
  assert.equal(isPassphraseOnlyTurn("falkens maze please check my email", secret), false);
  assert.equal(looksLikePhoneTaskRequest("check my email"), true);
  assert.equal(isPassphraseOnlyTurn("what is on my calendar", secret), false);
});
