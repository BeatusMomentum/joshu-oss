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
  assert.equal(snapshot.selectedItems[0]?.id, "element-99");
  assert.match(snapshot.selectedItems[0]?.text ?? "", /Element 99/);
});

test("selected sticky containers resolve bound text for deixis", () => {
  const stickyElements = [
    {
      id: "sticky-bg",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 200,
      height: 80,
      isDeleted: false,
      boundElements: [{ id: "sticky-text", type: "text" }],
      link: null,
    },
    {
      id: "sticky-text",
      type: "text",
      x: 20,
      y: 20,
      width: 180,
      height: 60,
      text: "Barnaby James & Megan Li\nStill need scheduling",
      originalText: "Barnaby James & Megan Li\nStill need scheduling",
      containerId: "sticky-bg",
      isDeleted: false,
      link: null,
    },
  ] as unknown as ExcalidrawElement[];

  const snapshot = createBoundedSceneSnapshot({
    elements: stickyElements,
    appState: {
      scrollX: 0,
      scrollY: 0,
      width: 1200,
      height: 800,
      zoom: { value: 1 },
      selectedElementIds: { "sticky-bg": true },
    } as Pick<
      AppState,
      "scrollX" | "scrollY" | "width" | "height" | "zoom" | "selectedElementIds"
    >,
    loadedFile: "Planning/board.excalidraw",
    workspace: null,
  });

  assert.equal(snapshot.selectedItems.length, 1);
  assert.equal(snapshot.selectedItems[0]?.id, "sticky-bg");
  assert.equal(snapshot.selectionSource, "live");
  assert.match(snapshot.selectedItems[0]?.text ?? "", /Barnaby James/);
  assert.match(snapshot.scenePreview.find((item) => item.id === "sticky-bg")?.text ?? "", /Barnaby/);
});

test("anchored selection survives empty live Excalidraw selection (chat focus)", () => {
  const stickyElements = [
    {
      id: "mauricio",
      type: "text",
      x: 10,
      y: 10,
      width: 200,
      height: 40,
      text: "Mauricio — call happened",
      originalText: "Mauricio — call happened",
      isDeleted: false,
      link: null,
    },
    {
      id: "barnaby",
      type: "text",
      x: 10,
      y: 80,
      width: 200,
      height: 40,
      text: "Barnaby James & Megan Li",
      originalText: "Barnaby James & Megan Li",
      isDeleted: false,
      link: null,
    },
    {
      id: "tyler",
      type: "text",
      x: 10,
      y: 150,
      width: 200,
      height: 40,
      text: "UP.Labs / Tyler",
      originalText: "UP.Labs / Tyler",
      isDeleted: false,
      link: null,
    },
  ] as unknown as ExcalidrawElement[];

  const snapshot = createBoundedSceneSnapshot({
    elements: stickyElements,
    appState: {
      scrollX: 0,
      scrollY: 0,
      width: 1200,
      height: 800,
      zoom: { value: 1 },
      // Empty: user clicked into the chat composer after selecting Mauricio + Barnaby.
      selectedElementIds: {},
    } as Pick<
      AppState,
      "scrollX" | "scrollY" | "width" | "height" | "zoom" | "selectedElementIds"
    >,
    loadedFile: "Planning/board.excalidraw",
    workspace: null,
    anchoredSelection: {
      selection: ["mauricio", "barnaby"],
      selectedItems: [
        { id: "mauricio", type: "text", text: "Mauricio — call happened" },
        { id: "barnaby", type: "text", text: "Barnaby James & Megan Li" },
      ],
    },
  });

  assert.equal(snapshot.selectionSource, "anchored");
  assert.deepEqual(
    snapshot.selectedItems.map((item) => item.id),
    ["mauricio", "barnaby"],
  );
  assert.equal(snapshot.scenePreview[0]?.id, "mauricio");
  assert.ok(!snapshot.selectedItems.some((item) => item.id === "tyler"));
});
