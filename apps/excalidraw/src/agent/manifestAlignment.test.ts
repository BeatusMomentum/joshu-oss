import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WHITEBOARD_GUI_ACTIONS, WHITEBOARD_MANIFEST } from "./whiteboardAppManifest";

test("frontend and packaged whiteboard manifests expose the same safe actions", () => {
  const manifestUrl = new URL(
    "../../../../arozos/subservice/excalidraw/joshu.app.json",
    import.meta.url,
  );
  const packaged = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
    agent?: { guiActions?: Array<{ name?: string }> };
  };
  const frontendNames = WHITEBOARD_GUI_ACTIONS.map((action) => action.name);
  const packagedNames = packaged.agent?.guiActions?.map((action) => action.name) ?? [];

  assert.deepEqual(packagedNames, frontendNames);
  assert.deepEqual(
    packaged.agent?.guiActions,
    JSON.parse(JSON.stringify(WHITEBOARD_GUI_ACTIONS)),
  );
  assert.deepEqual(
    WHITEBOARD_MANIFEST.agent?.guiActions?.map((action) => action.name),
    frontendNames,
  );
  const recall = WHITEBOARD_GUI_ACTIONS.find((action) => action.name === "recallToBoard");
  assert.ok(recall);
  assert.deepEqual(
    recall.parameters.map((parameter) => parameter.name),
    ["query", "limit"],
  );
  assert.equal(frontendNames.includes("acceptProposal" as never), false);
  assert.equal(frontendNames.includes("rejectProposal" as never), false);
  assert.equal(frontendNames.includes("commit" as never), false);
});
