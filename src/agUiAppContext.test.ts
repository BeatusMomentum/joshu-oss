import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhiteboardBoardMutationNudge,
  isExcalidrawBoardMutatingAction,
  latestUserText,
  requiresExcalidrawBoardMutation,
} from "./agUiAppContext.js";

test("board-mutating actions are propose/recall/stage only", () => {
  assert.equal(isExcalidrawBoardMutatingAction("proposeTransaction"), true);
  assert.equal(isExcalidrawBoardMutatingAction("recallToBoard"), true);
  assert.equal(isExcalidrawBoardMutatingAction("stageOpening"), true);
  assert.equal(isExcalidrawBoardMutatingAction("showFocus"), false);
  assert.equal(isExcalidrawBoardMutatingAction("openBoard"), false);
});

test("empty ready board requires mutation for any non-trivial turn", () => {
  assert.equal(
    requiresExcalidrawBoardMutation({ cwmReady: true, scenePreview: [] }, "lets review action items"),
    true,
  );
  assert.equal(
    requiresExcalidrawBoardMutation({ cwmReady: true, scenePreview: [] }, "ok"),
    false,
  );
  assert.equal(
    requiresExcalidrawBoardMutation({ cwmReady: false, scenePreview: [] }, "review action items"),
    false,
  );
});

test("populated board requires mutation for review/orient language only", () => {
  const gui = {
    cwmReady: true,
    scenePreview: [{ id: "a", text: "existing sticky" }],
  };
  assert.equal(requiresExcalidrawBoardMutation(gui, "how many stickies do I see?"), false);
  assert.equal(requiresExcalidrawBoardMutation(gui, "review action items across pipelines"), true);
  assert.equal(requiresExcalidrawBoardMutation(gui, "what's open"), true);
});

test("latestUserText ignores earlier turns", () => {
  assert.equal(
    latestUserText([
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
    ]),
    "second",
  );
});

test("board mutation nudge mentions protocol and guiActions", () => {
  const nudge = buildWhiteboardBoardMutationNudge();
  assert.match(nudge, /PROTOCOL VIOLATION/);
  assert.match(nudge, /proposeTransaction/);
});
