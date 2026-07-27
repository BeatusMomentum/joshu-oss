import assert from "node:assert/strict";
import test from "node:test";

import { coerceAgentTransaction, coerceStageOpening } from "./cwmCoercion";

const now = "2026-07-27T00:00:00.000Z";

test("stageOpening creates only AI proposals with source provenance", () => {
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
    assert.equal(operations[0].object.status, "PROPOSED");
    assert.equal(operations[0].object.createdBy, "AI");
    assert.equal(operations[0].object.provenance[0]?.sourceUri, "joshu://Planning/launch.md");
  }
  assert.equal(operations[1]?.type, "SET_OPENING_BRIEF");
});

test("agent transactions force proposed AI semantics and reject authority escalation", () => {
  const transaction = coerceAgentTransaction(
    {
      transaction: {
        rationale: "Source-backed candidate",
        operations: [
          {
            type: "UPSERT_OBJECT",
            object: {
              id: "claim",
              kind: "Claim",
              layer: "SENSEMAKING",
              status: "DECIDED",
              body: "Candidate interpretation",
              provenance: [{ sourceId: "source-1", excerpt: "Grounding" }],
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
    assert.equal(operation.object.status, "PROPOSED");
    assert.equal(operation.object.createdBy, "AI");
  }

  assert.throws(
    () =>
      coerceAgentTransaction({
        transaction: {
          rationale: "Delete",
          operations: [{ type: "REMOVE_OBJECT", objectId: "claim" }],
        },
      }),
    /not agent-safe/,
  );
  assert.throws(
    () =>
      coerceAgentTransaction({
        transaction: {
          rationale: "Commit",
          operations: [
            {
              type: "UPSERT_OBJECT",
              object: {
                id: "decision",
                layer: "COMMITMENT",
                body: "Ship it",
                provenance: [{ sourceId: "source-1" }],
              },
            },
          ],
        },
      }),
    /cannot create commitment/,
  );
});

test("hallucinated add_note content is recovered into a conversation-grounded Comment", () => {
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
    assert.equal(operation.object.kind, "Comment");
    assert.equal(operation.object.status, "PROPOSED");
    assert.equal(operation.object.provenance[0]?.kind, "CONVERSATION");
    assert.match(operation.object.body, /Things to attend to/);
  }
});

test("UPSERT_OBJECT without provenance defaults to conversation grounding", () => {
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
    assert.equal(operation.object.kind, "Comment");
    assert.equal(operation.object.status, "PROPOSED");
    assert.match(operation.object.body, /Barnaby James/);
    assert.equal(operation.object.provenance[0]?.kind, "CONVERSATION");
  }
});
