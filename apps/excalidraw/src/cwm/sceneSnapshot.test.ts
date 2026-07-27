import assert from "node:assert/strict";
import test from "node:test";

import type { CwmWorkspace } from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import {
  CWM_SNAPSHOT_MAX_BYTES,
  CWM_SNAPSHOT_MAX_ELEMENT_TEXT,
  CWM_SNAPSHOT_MAX_ELEMENTS,
  createBoundedSceneSnapshot,
  snapshotSerializedBytes,
} from "./sceneSnapshot";

const elements = Array.from({ length: 100 }, (_, index) => ({
  id: `element-${index}`,
  type: "text",
  x: index * 500,
  y: index * 500,
  width: 100,
  height: 40,
  text: `Element ${index} ${"large ".repeat(100)}`,
  originalText: `Element ${index} ${"large ".repeat(100)}`,
  isDeleted: false,
  link: null,
})) as unknown as ExcalidrawElement[];

const workspace = {
  schemaVersion: 1,
  id: "workspace-test",
  mode: "ORIENT",
  objects: {},
  relations: {},
  regions: {},
  proposals: {},
  focus: null,
  openingBrief: {
    summary: "Brief ".repeat(1_000),
    sourceObjectIds: Array.from({ length: 100 }, (_, index) => `source-${index}`),
    preparedBy: "AI",
    preparedAt: "2026-07-27T00:00:00.000Z",
  },
  headSequence: 0,
} as CwmWorkspace;

test("scene snapshots enforce count, text, and serialized byte caps", () => {
  const snapshot = createBoundedSceneSnapshot({
    elements,
    appState: {
      scrollX: 0,
      scrollY: 0,
      width: 1200,
      height: 800,
      zoom: { value: 1 },
      selectedElementIds: { "element-99": true },
    } as Pick<
      AppState,
      "scrollX" | "scrollY" | "width" | "height" | "zoom" | "selectedElementIds"
    >,
    loadedFile: `Planning/${"nested/".repeat(100)}board.excalidraw`,
    workspace,
  });

  assert.ok(snapshot.scenePreview.length <= CWM_SNAPSHOT_MAX_ELEMENTS);
  assert.ok(snapshot.scenePreview.every((element) => element.text.length <= CWM_SNAPSHOT_MAX_ELEMENT_TEXT));
  assert.ok(snapshotSerializedBytes(snapshot) <= CWM_SNAPSHOT_MAX_BYTES);
  assert.equal(snapshot.scenePreview[0]?.id, "element-99", "selection should outrank viewport visibility");
});
