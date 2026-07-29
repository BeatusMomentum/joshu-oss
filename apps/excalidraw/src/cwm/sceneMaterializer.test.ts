import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyWorkspace,
  type CwmObject,
  type CwmSemanticOperation,
} from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  composeCardText,
  materializeConfirmedOperations,
  normalizeSemanticOperations,
} from "./sceneMaterializer";

const workspace = createEmptyWorkspace({ id: "workspace-materializer" });
const object: CwmObject = {
  id: "claim-one",
  kind: "note",
  phase: "accepted",
  title: "A source-backed claim",
  body: "The semantic workspace owns this meaning.",
  createdBy: "AI",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  provenance: [],
  geometry: { x: 100, y: 120, width: 240, height: 130 },
};

test("normalization assigns stable client scene bindings", () => {
  const operation: CwmSemanticOperation = { type: "UPSERT_OBJECT", object };
  const first = normalizeSemanticOperations([operation], workspace)[0];
  const second = normalizeSemanticOperations([operation], workspace)[0];
  assert.equal(first?.type, "UPSERT_OBJECT");
  assert.equal(second?.type, "UPSERT_OBJECT");
  if (first?.type !== "UPSERT_OBJECT" || second?.type !== "UPSERT_OBJECT") return;

  assert.deepEqual(first.object.sceneBinding, second.object.sceneBinding);
  assert.equal(first.object.sceneBinding?.elementIds.length, 2);
  assert.equal(workspace.objects[object.id], undefined, "normalization must not mutate committed state");
});

test("materialize leaves original sticky text alone and only adds an action note", () => {
  const sticky = {
    id: "sticky-bg",
    type: "rectangle",
    x: 100,
    y: 50,
    width: 200,
    height: 80,
    isDeleted: false,
    boundElements: [{ id: "sticky-text", type: "text" }],
  } as unknown as ExcalidrawElement;
  const stickyText = {
    id: "sticky-text",
    type: "text",
    x: 110,
    y: 60,
    width: 180,
    height: 60,
    text: "Mauricio call pending",
    originalText: "Mauricio call pending",
    containerId: "sticky-bg",
    isDeleted: false,
  } as unknown as ExcalidrawElement;

  const updated: CwmObject = {
    ...object,
    id: "note-mauricio",
    title: "Mauricio call",
    body: "Mauricio call happened — COMPLETED",
    sceneBinding: { elementIds: ["sticky-bg", "sticky-text"], primaryElementId: "sticky-bg" },
  };
  const next = materializeConfirmedOperations(
    [sticky, stickyText],
    [{ type: "UPSERT_OBJECT", object: updated }],
    workspace,
    "Mark Mauricio call done",
  );
  const note = next.find(
    (element) =>
      (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "action_note",
  );
  assert.ok(note, "expected a plain action note");
  assert.equal(note?.type, "text");
  assert.match(String((note as { text?: string }).text ?? ""), /↳/);
  assert.ok((note?.y ?? 0) >= sticky.y + sticky.height);
  const textEl = next.find((element) => element.id === "sticky-text") as { text?: string } | undefined;
  assert.equal(textEl?.text, "Mauricio call pending", "original sticky text must stay unchanged");
});

test("new cards materialize without a redundant batch action note", () => {
  const normalized = normalizeSemanticOperations([{ type: "UPSERT_OBJECT", object }], workspace);
  const committed = materializeConfirmedOperations([], normalized, workspace, "Action items review");
  assert.ok(committed.some((element) => element.type === "rectangle" && element.strokeStyle === "solid"));
  assert.equal(
    committed.filter(
      (element) =>
        (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "action_note",
    ).length,
    0,
    "fresh cards should not all get the transaction rationale stamped under them",
  );
});

test("identical re-UPSERT of existing CWM cards does not spam action notes", () => {
  const normalized = normalizeSemanticOperations([{ type: "UPSERT_OBJECT", object }], workspace);
  const first = materializeConfirmedOperations([], normalized, workspace, "Action items review");
  const withObject = {
    ...workspace,
    objects: {
      [object.id]: {
        ...object,
        sceneBinding:
          normalized[0]?.type === "UPSERT_OBJECT" ? normalized[0].object.sceneBinding : undefined,
      },
    },
  };
  const second = materializeConfirmedOperations(
    first,
    normalized,
    withObject,
    "Action items review again",
  );
  assert.equal(
    second.filter(
      (element) =>
        (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "action_note",
    ).length,
    0,
  );
});

test("new cards bind text to the rectangle and grow height for wrapped body", () => {
  const longBody = [
    "Google Labs GPM, Mauricio call done, Barnaby + Megan still open.",
    "UP.Labs onsite happened; Jackson follow-up status unclear.",
    "Allen Hua — OneNote export + signup.",
    "Mara Chaben — Asterisk scheduling.",
    "Thierry Ho — still awaiting reply on the investor list.",
  ].join("\n");
  const longObject: CwmObject = {
    ...object,
    id: "long-note",
    title: "Waiting on Others",
    body: longBody,
    geometry: undefined,
  };
  const normalized = normalizeSemanticOperations([{ type: "UPSERT_OBJECT", object: longObject }], workspace);
  const committed = materializeConfirmedOperations([], normalized, workspace, "Seed board");
  const card = committed.find(
    (element) =>
      element.type === "rectangle" &&
      (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "card",
  ) as
    | {
        id: string;
        height: number;
        width: number;
        boundElements?: Array<{ id: string; type: string }>;
      }
    | undefined;
  const text = committed.find(
    (element) =>
      element.type === "text" &&
      (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "text",
  ) as
    | {
        containerId?: string | null;
        autoResize?: boolean;
        originalText?: string;
        text?: string;
        height: number;
      }
    | undefined;

  assert.ok(card, "expected a card rectangle");
  assert.ok(text, "expected bound text");
  assert.equal(text?.containerId, card?.id);
  assert.equal(text?.autoResize, true);
  assert.equal(card?.boundElements?.length, 1);
  assert.equal(card?.boundElements?.[0]?.type, "text");
  assert.ok((card?.height ?? 0) > 130, `card should grow beyond fixed 130px, got ${card?.height}`);
  assert.match(String(text?.originalText ?? ""), /Thierry Ho/);
  assert.ok(!String(text?.text ?? "").includes("…"), "wrapped text must not use ellipsis truncation");
});

test("new cards without geometry pack into a 2-column layout", () => {
  const a: CwmObject = { ...object, id: "pack-a", title: "A", body: "First card", geometry: undefined };
  const b: CwmObject = { ...object, id: "pack-b", title: "B", body: "Second card", geometry: undefined };
  const normalized = normalizeSemanticOperations(
    [
      { type: "UPSERT_OBJECT", object: a },
      { type: "UPSERT_OBJECT", object: b },
    ],
    workspace,
  );
  const committed = materializeConfirmedOperations([], normalized, workspace, "Pack");
  const cards = committed.filter(
    (element) =>
      element.type === "rectangle" &&
      (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "card",
  );
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.y, cards[1]?.y, "first row shares the same y");
  assert.ok((cards[1]?.x ?? 0) > (cards[0]?.x ?? 0), "second card sits in the next column");
});

test("composeCardText does not duplicate identical title and body", () => {
  assert.equal(
    composeCardText("Same sticky text", "Same sticky text"),
    "Same sticky text",
  );
  assert.equal(
    composeCardText("Short title", "Short title with more detail later"),
    "Short title with more detail later",
  );
  assert.equal(
    composeCardText("Title", "Distinct body"),
    "Title\nDistinct body",
  );
});

test("materialize omits duplicated title when body already includes it", () => {
  const dup: CwmObject = {
    ...object,
    id: "dup-note",
    title: "3 open tasks: verify Mauricio call",
    body: "3 open tasks: verify Mauricio call",
    geometry: undefined,
  };
  const normalized = normalizeSemanticOperations([{ type: "UPSERT_OBJECT", object: dup }], workspace);
  const committed = materializeConfirmedOperations([], normalized, workspace, "Dedup");
  const text = committed.find(
    (element) =>
      element.type === "text" &&
      (element.customData as { cwm?: { role?: string } } | undefined)?.cwm?.role === "text",
  ) as { originalText?: string } | undefined;
  assert.equal(text?.originalText, "3 open tasks: verify Mauricio call");
});
