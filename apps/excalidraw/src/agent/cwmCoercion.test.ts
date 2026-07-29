import assert from "node:assert/strict";
import test from "node:test";

import { coerceAgentTransaction, coerceStageOpening } from "./cwmCoercion";

const now = "2026-07-27T00:00:00.000Z";

test("stageOpening creates accepted notes with source provenance", () => {
  const operations = coerceStageOpening(
    {
      brief: {
        whatChanged: ["A deadline moved"],
        tensions: ["Speed versus confidence"],
        openQuestions: ["Who validates the source?"],
        starts: ["Verify the deadline", "Map dependencies"],
      },
      sources: {
        deadline: {
          id: "deadline",
          title: "Deadline note",
          body: "The launch date moved.",
          sourceUri: "joshu://Planning/launch.md",
          kind: "FILE",
        },
      },
    },
    now,
  );

  assert.equal(operations.length, 2);
  assert.equal(operations[0]?.type, "UPSERT_OBJECT");
  if (operations[0]?.type === "UPSERT_OBJECT") {
    assert.equal(operations[0].object.kind, "note");
    assert.equal(operations[0].object.phase, "accepted");
    assert.equal(operations[0].object.createdBy, "AI");
    assert.equal(operations[0].object.provenance[0]?.sourceUri, "joshu://Planning/launch.md");
  }
  assert.equal(operations[1]?.type, "SET_OPENING_BRIEF");
});

test("agent transactions auto-classify kinds and gate only decisions", () => {
  const noteTx = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Source-backed candidate",
        operations: [
          {
            type: "UPSERT_OBJECT",
            object: {
              id: "claim",
              kind: "Claim",
              body: "Candidate interpretation",
              provenance: [{ sourceId: "source-1", excerpt: "Grounding" }],
            },
          },
        ],
      },
    },
    now,
  );
  const noteOp = noteTx.operations[0];
  assert.equal(noteOp?.type, "UPSERT_OBJECT");
  if (noteOp?.type === "UPSERT_OBJECT") {
    assert.equal(noteOp.object.kind, "note");
    assert.equal(noteOp.object.phase, "accepted");
    assert.equal(noteOp.object.createdBy, "AI");
  }

  const decisionTx = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Commit",
        operations: [
          {
            type: "UPSERT_OBJECT",
            object: {
              id: "decision",
              kind: "decision",
              body: "Ship it this week",
              provenance: [{ sourceId: "source-1" }],
            },
          },
        ],
      },
    },
    now,
  );
  const decisionOp = decisionTx.operations[0];
  assert.equal(decisionOp?.type, "UPSERT_OBJECT");
  if (decisionOp?.type === "UPSERT_OBJECT") {
    assert.equal(decisionOp.object.kind, "decision");
    assert.equal(decisionOp.object.phase, "accepted");
  }

  assert.throws(
    () =>
      coerceAgentTransaction({
        transaction: {
          rationale: "Delete",
          operations: [{ type: "REMOVE_OBJECT", objectId: "claim" }],
        },
      }),
    /UPSERT_OBJECT|not agent-safe|forbidden|needs type/,
  );
});

test("hallucinated add_note content is recovered into an accepted note", () => {
  const transaction = coerceAgentTransaction(
    {
      transaction: {
        type: "add_note",
        content: "Things to attend to:\n1. Follow up\n2. Decide onsite",
      },
    },
    now,
  );
  assert.equal(transaction.operations.length, 1);
  const operation = transaction.operations[0];
  assert.equal(operation?.type, "UPSERT_OBJECT");
  if (operation?.type === "UPSERT_OBJECT") {
    assert.equal(operation.object.kind, "note");
    assert.equal(operation.object.phase, "accepted");
    assert.equal(operation.object.provenance[0]?.kind, "CONVERSATION");
    assert.match(operation.object.body, /Things to attend to/);
  }
});

test("questions auto-classify as open_question", () => {
  const transaction = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Sticky from chat",
        operations: [
          {
            type: "UPSERT_OBJECT",
            object: {
              kind: "Question",
              body: "Did the Mauricio call happen?",
            },
          },
        ],
      },
    },
    now,
  );
  const operation = transaction.operations[0];
  assert.equal(operation?.type, "UPSERT_OBJECT");
  if (operation?.type === "UPSERT_OBJECT") {
    assert.equal(operation.object.kind, "open_question");
    assert.equal(operation.object.phase, "accepted");
    assert.equal(operation.object.provenance[0]?.kind, "CONVERSATION");
    assert.equal(operation.object.provenance[0]?.sourceId, "conversation");
  }
});

test("flat UPSERT_OBJECT with text recovers nested object semantics", () => {
  const transaction = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Add follow-up sticky",
        operations: [
          {
            id: "sticky-barnaby",
            type: "UPSERT_OBJECT",
            elementType: "text",
            x: 460,
            y: -45,
            text: "Barnaby James & Megan Li\nStill need scheduling",
          },
        ],
      },
    },
    now,
  );
  const operation = transaction.operations[0];
  assert.equal(operation?.type, "UPSERT_OBJECT");
  if (operation?.type === "UPSERT_OBJECT") {
    assert.equal(operation.object.id, "sticky-barnaby");
    assert.equal(operation.object.kind, "note");
    assert.equal(operation.object.phase, "accepted");
    assert.match(operation.object.body, /Barnaby James/);
    assert.equal(operation.object.provenance[0]?.kind, "CONVERSATION");
  }
});

test("recovers kind:UPSERT_OBJECT and string provenance (board-3 hallucination)", () => {
  const transaction = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Seed the empty board",
        operations: [
          {
            kind: "UPSERT_OBJECT",
            object: {
              kind: "note",
              title: "Today's new ideas (Jul 27)",
              body: "Voice agent spawning\nWhiteboard app\nAsync workflows",
              provenance: "Dan's note-to-self via Nylas thread.",
            },
          },
          {
            kind: "UPSERT_OBJECT",
            object: {
              kind: "open_question",
              title: "Central tension",
              body: "Ideas arriving faster than execution?",
              provenance: "Synthesis across todo.md",
            },
          },
        ],
      },
    },
    now,
  );
  assert.equal(transaction.operations.length, 2);
  const first = transaction.operations[0];
  assert.equal(first?.type, "UPSERT_OBJECT");
  if (first?.type === "UPSERT_OBJECT") {
    assert.equal(first.object.kind, "note");
    assert.equal(first.object.provenance[0]?.kind, "CONVERSATION");
    assert.match(first.object.provenance[0]?.excerpt ?? "", /Nylas/);
  }
  const second = transaction.operations[1];
  assert.equal(second?.type, "UPSERT_OBJECT");
  if (second?.type === "UPSERT_OBJECT") {
    assert.equal(second.object.kind, "open_question");
  }
});

test("stageOpening accepts string brief and path/label sources", () => {
  const operations = coerceStageOpening(
    {
      brief:
        "Fresh board. Product backlog growing. Google Labs and UP.Labs in limbo.",
      sources: [
        {
          path: "Projects/joshu-product-development/todo.md",
          label: "joshu-product-development todo",
        },
      ],
      tensions: ["Backlog growing faster than execution"],
    },
    now,
  );
  assert.equal(operations.length, 2);
  assert.equal(operations[0]?.type, "UPSERT_OBJECT");
  if (operations[0]?.type === "UPSERT_OBJECT") {
    assert.match(operations[0].object.body, /todo/);
    assert.equal(
      operations[0].object.provenance[0]?.sourceId,
      "Projects/joshu-product-development/todo.md",
    );
  }
  assert.equal(operations[1]?.type, "SET_OPENING_BRIEF");
  if (operations[1]?.type === "SET_OPENING_BRIEF") {
    assert.match(operations[1].openingBrief.summary, /Fresh board/);
    assert.match(operations[1].openingBrief.summary, /Backlog growing/);
  }
});
