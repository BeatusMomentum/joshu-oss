import assert from "node:assert/strict";
import test from "node:test";

import { newBoardPathFromName } from "./newBoard";

test("new board names resolve under Planning with a lowercase extension", () => {
  assert.equal(newBoardPathFromName("Research map"), "Planning/Research map.excalidraw");
  assert.equal(
    newBoardPathFromName("  Strategy.EXCALIDRAW  "),
    "Planning/Strategy.excalidraw",
  );
});

test("new board names reject traversal and non-portable filenames", () => {
  for (const name of ["", ".", "..", "../escape", "folder/board", "bad:name", "trailing."]) {
    assert.throws(() => newBoardPathFromName(name));
  }
});
