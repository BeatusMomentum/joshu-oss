import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyWorkspace,
  type CwmObject,
  type CwmProposal,
  type CwmSemanticOperation,
} from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  materializeConfirmedOperations,
  materializeProposalPreview,
  normalizeSemanticOperations,
} from "./sceneMaterializer";

const workspace = createEmptyWorkspace({ id: "workspace-materializer" });
const object: CwmObject = {
  id: "claim-one",
  kind: "Claim",
  layer: "EVIDENCE",
  status: "PROPOSED",
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

test("proposal ghosts materialize without committing, then retain IDs on confirmation", () => {
  const normalized = normalizeSemanticOperations(
    [{ type: "UPSERT_OBJECT", object }],
    workspace,
  );
  const proposal: CwmProposal = {
    id: "proposal-one",
    workspaceId: workspace.id,
    proposedBy: "AI",
    actionClass: "EPISTEMIC",
    operations: normalized,
    status: "PENDING",
    createdAt: "2026-07-27T00:00:00.000Z",
  };
  const preview = materializeProposalPreview(proposal, [], workspace);
  assert.equal(preview.length, 2);
  assert.ok(preview.every((element) => element.strokeStyle === "dashed" && element.opacity < 100));
  assert.equal(workspace.objects[object.id], undefined);

  const committed = materializeConfirmedOperations(
    preview as readonly ExcalidrawElement[],
    normalized,
    workspace,
  );
  const finalIds =
    normalized[0]?.type === "UPSERT_OBJECT"
      ? normalized[0].object.sceneBinding?.elementIds
      : undefined;
  assert.deepEqual(
    committed.map((element) => element.id).sort(),
    [...(finalIds ?? [])].sort(),
  );
  assert.ok(committed.every((element) => element.strokeStyle === "solid" && element.opacity === 100));
  assert.ok(
    committed.every(
      (element) =>
        !(element.customData as { cwm?: { preview?: boolean } } | undefined)?.cwm?.preview,
    ),
  );
});
