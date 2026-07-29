import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CWM_HANDOFF_MARKDOWN_LENGTH,
  classifyCwmHandoff,
  createEmptyWorkspace,
  renderCwmSessionMarkdown,
} from "../dist/index.js";

const timestamp = "2026-07-27T01:00:00.000Z";

function object(id, kind, phase, body = `Body for ${id}`) {
  return {
    id,
    kind,
    phase,
    title: id,
    body,
    createdBy: "HUMAN",
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: [
      {
        id: `provenance-${id}`,
        kind: "FILE",
        sourceId: `source-${id}`,
        sourceUri: `joshu://research/${id}.md`,
        locator: `research/${id}.md`,
        capturedBy: "HUMAN",
        capturedAt: timestamp,
      },
    ],
  };
}

test("handoff classification excludes pending proposals from accepted decisions", () => {
  const acceptedDecision = object("accepted", "decision", "accepted");
  const pendingDecision = object("pending", "decision", "pending");
  const rejectedDecision = object("recoverable", "decision", "pending");
  const workspace = {
    ...createEmptyWorkspace({ id: "board" }),
    objects: {
      accepted: acceptedDecision,
      evidence: object("evidence", "note", "accepted"),
      question: object("question", "open_question", "accepted"),
    },
    proposals: {
      pending: {
        id: "pending",
        workspaceId: "board",
        proposedBy: "AI",
        actionClass: "COMMITMENT",
        operations: [{ type: "UPSERT_OBJECT", object: pendingDecision }],
        status: "PENDING",
        createdAt: timestamp,
      },
      rejected: {
        id: "rejected",
        workspaceId: "board",
        proposedBy: "AI",
        actionClass: "COMMITMENT",
        operations: [{ type: "UPSERT_OBJECT", object: rejectedDecision }],
        rationale: "Useful alternative if assumptions change",
        status: "REJECTED",
        createdAt: timestamp,
        resolvedAt: timestamp,
        resolvedBy: "HUMAN",
      },
    },
    headSequence: 4,
  };

  const classified = classifyCwmHandoff(workspace);
  assert.deepEqual(classified.decisionsAndCommitments.map((entry) => entry.id), ["accepted"]);
  assert.deepEqual(classified.rejectedOptions.map((entry) => entry.object.id), ["recoverable"]);

  const markdown = renderCwmSessionMarkdown({
    workspace,
    boardPath: "Planning/strategy.excalidraw",
    consolidatedAt: "2026-07-27T02:00:00.000Z",
  });
  assert.match(markdown, /Planning\/strategy\.excalidraw/);
  assert.match(markdown, /## Accepted decisions/);
  assert.match(markdown, /## Dismissed decisions/);
  assert.match(markdown, /Useful alternative if assumptions change/);
  assert.doesNotMatch(markdown, /### pending/);
  assert.ok(markdown.length <= MAX_CWM_HANDOFF_MARKDOWN_LENGTH);
});

test("handoff rendering stays bounded for large accepted workspaces", () => {
  const objects = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => {
      const id = `evidence-${index}`;
      return [id, object(id, "note", "accepted", "x".repeat(10_000))];
    }),
  );
  const workspace = { ...createEmptyWorkspace({ id: "large" }), objects };
  const markdown = renderCwmSessionMarkdown({
    workspace,
    boardPath: "Planning/large.excalidraw",
    consolidatedAt: timestamp,
  });
  assert.ok(markdown.length <= MAX_CWM_HANDOFF_MARKDOWN_LENGTH);
  const renderedEvidence = (markdown.match(/^### evidence-/gm) ?? []).length;
  assert.ok(renderedEvidence > 0 && renderedEvidence <= 12);
  assert.match(markdown, /## Dismissed decisions/);
});
