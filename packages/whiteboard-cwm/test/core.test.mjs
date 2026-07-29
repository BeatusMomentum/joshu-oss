import assert from "node:assert/strict";
import test from "node:test";

import {
  CwmValidationError,
  applyCwmOperations,
  assertValidCwmWorkspace,
  authorityPolicyFor,
  classifyCwmOperations,
  createCompensatingEvent,
  createEmptyWorkspace,
  deriveInverseOperations,
  normalizeCwmObjectKind,
  opRemoveObject,
  opSetFocus,
  opSetOpeningBrief,
  opSetSceneBinding,
  opUpsertObject,
  opUpsertRegion,
  opUpsertRelation,
  replayCwmEvents,
  validateCwmEvent,
  validateCwmWorkspace,
} from "../dist/index.js";

const actor = "HUMAN";
const timestamp = "2026-07-27T00:00:00.000Z";

function object(id, kind = "note") {
  return {
    id,
    kind,
    phase: kind === "decision" ? "accepted" : "accepted",
    body: `Body for ${id}`,
    createdBy: actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: [],
  };
}

function region(id, objectIds) {
  return {
    id,
    title: id,
    phase: "accepted",
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    objectIds,
    createdBy: actor,
    createdAt: timestamp,
  };
}

function relation(id, sourceId, targetId) {
  return {
    id,
    kind: "SUPPORTS",
    source: { kind: "OBJECT", id: sourceId },
    target: { kind: "OBJECT", id: targetId },
    phase: "accepted",
    createdBy: actor,
    createdAt: timestamp,
  };
}

test("authority policy applies object kinds immediately", () => {
  assert.equal(authorityPolicyFor("MECHANICAL").appliesImmediately, true);
  assert.equal(authorityPolicyFor("COMMITMENT").requiresConfirmation, true);

  assert.equal(classifyCwmOperations([opSetFocus(null)]), "EPHEMERAL");
  assert.equal(
    classifyCwmOperations([opSetFocus(null), opSetSceneBinding("a", null)]),
    "MECHANICAL",
  );
  assert.equal(classifyCwmOperations([opUpsertObject(object("a"))]), "MECHANICAL");
  assert.equal(
    classifyCwmOperations([opUpsertObject(object("decision", "decision"))]),
    "MECHANICAL",
  );
  assert.equal(normalizeCwmObjectKind("Question"), "open_question");
  assert.equal(normalizeCwmObjectKind("Task"), "decision");
});

test("operations are pure and object removal cleans references", () => {
  const empty = createEmptyWorkspace({ id: "board-1" });
  const populated = applyCwmOperations(empty, [
    opUpsertObject(object("a")),
    opUpsertObject(object("b")),
    opUpsertRegion(region("r", ["a", "b"])),
    opUpsertRelation(relation("rel", "a", "b")),
    opSetFocus({ objectIds: ["a"], regionIds: ["r"] }),
  ]);

  const removed = applyCwmOperations(populated, [opRemoveObject("a")]);
  assert.ok(populated.objects.a, "input state was not mutated");
  assert.equal(removed.objects.a, undefined);
  assert.equal(removed.relations.rel, undefined);
  assert.deepEqual(removed.regions.r.objectIds, ["b"]);
  assert.deepEqual(removed.focus.objectIds, []);
});

test("derived inverse restores cascaded object removal exactly", () => {
  const before = applyCwmOperations(createEmptyWorkspace({ id: "board-1" }), [
    opUpsertObject(object("a")),
    opUpsertObject(object("b")),
    opUpsertRegion(region("r", ["a", "b"])),
    opUpsertRelation(relation("rel", "a", "b")),
    opSetFocus({ objectIds: ["a", "b"], regionIds: ["r"], reason: "compare" }),
    opSetOpeningBrief({
      summary: "Review both notes",
      sourceObjectIds: ["a", "b"],
      preparedBy: "AI",
      preparedAt: timestamp,
    }),
  ]);
  const forward = [opRemoveObject("a")];
  const inverse = deriveInverseOperations(before, forward);
  const restored = applyCwmOperations(applyCwmOperations(before, forward), inverse);
  assert.deepEqual(restored, before);
});

test("proposal replay confirms decisions and compensation appends an inverse", () => {
  const initial = createEmptyWorkspace({ id: "board-1" });
  const operation = opUpsertObject(object("claim", "decision"));
  const proposal = {
    id: "proposal-1",
    workspaceId: "board-1",
    proposedBy: "AI",
    actionClass: "COMMITMENT",
    operations: [operation],
    rationale: "Move forward",
    status: "PENDING",
    createdAt: timestamp,
  };
  const created = {
    id: "event-1",
    workspaceId: "board-1",
    sequence: 1,
    kind: "PROPOSAL_CREATED",
    actor: proposal.proposedBy,
    actionClass: "COMMITMENT",
    occurredAt: timestamp,
    operations: [],
    proposal,
  };
  const beforeConfirmation = replayCwmEvents(initial, [created]);
  const inverseOperations = deriveInverseOperations(beforeConfirmation, [operation]);
  const confirmed = {
    id: "event-2",
    workspaceId: "board-1",
    sequence: 2,
    kind: "PROPOSAL_CONFIRMED",
    actor,
    actionClass: "COMMITMENT",
    occurredAt: timestamp,
    operations: [operation],
    inverseOperations,
    proposalId: proposal.id,
  };
  const confirmedState = replayCwmEvents(beforeConfirmation, [confirmed]);
  assert.ok(confirmedState.objects.claim);
  assert.equal(confirmedState.proposals[proposal.id].status, "CONFIRMED");

  const compensation = createCompensatingEvent(confirmed, beforeConfirmation, {
    id: "event-3",
    sequence: 3,
    actor,
    occurredAt: timestamp,
    reason: "Owner undid confirmation",
  });
  const compensatedState = replayCwmEvents(confirmedState, [compensation]);
  assert.equal(compensatedState.objects.claim, undefined);
  assert.equal(compensation.compensatesEventId, confirmed.id);
  assert.equal(compensatedState.headSequence, 3);
});

test("reducer rejects unconfirmed decision application and sequence gaps", () => {
  const initial = createEmptyWorkspace({ id: "board-1" });
  const direct = {
    id: "event-1",
    workspaceId: "board-1",
    sequence: 1,
    kind: "OPERATIONS_APPLIED",
    actor: "AI",
    actionClass: "COMMITMENT",
    occurredAt: timestamp,
    operations: [opUpsertObject(object("claim", "decision"))],
  };
  assert.throws(
    () => replayCwmEvents(initial, [direct]),
    /cannot be applied without proposal confirmation/,
  );
  assert.throws(
    () => replayCwmEvents(initial, [{ ...direct, sequence: 2, actionClass: "EPHEMERAL" }]),
    /Expected event sequence 1/,
  );
  assert.throws(
    () =>
      replayCwmEvents(initial, [
        {
          ...direct,
          actionClass: "MECHANICAL",
          operations: [],
        },
      ]),
    /missing inverseOperations/,
  );
});

test("notes apply immediately without a proposal", () => {
  const initial = createEmptyWorkspace({ id: "board-1" });
  const ops = [opUpsertObject(object("n1", "note"))];
  const applied = {
    id: "event-1",
    workspaceId: "board-1",
    sequence: 1,
    kind: "OPERATIONS_APPLIED",
    actor: "AI",
    actionClass: "MECHANICAL",
    occurredAt: timestamp,
    operations: ops,
    inverseOperations: deriveInverseOperations(initial, ops),
  };
  const next = replayCwmEvents(initial, [applied]);
  assert.equal(next.objects.n1.kind, "note");
});

test("runtime validation migrates legacy kinds and reports referential errors", () => {
  const legacy = {
    ...createEmptyWorkspace({ id: "board-1" }),
    objects: {
      a: {
        id: "a",
        kind: "Question",
        layer: "SENSEMAKING",
        status: "PROPOSED",
        body: "legacy",
        createdBy: actor,
        createdAt: timestamp,
        updatedAt: timestamp,
        provenance: [],
      },
    },
  };
  const validated = assertValidCwmWorkspace(legacy);
  assert.equal(validated.objects.a.kind, "open_question");
  assert.equal(validated.objects.a.phase, "pending");

  const dangling = {
    ...validated,
    regions: { r: region("r", ["missing"]) },
  };
  const result = validateCwmWorkspace(dangling);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].path, /regions/);
  assert.match(result.errors[0].message, /missing object/);
  assert.throws(
    () => assertValidCwmWorkspace(dangling),
    (error) =>
      error instanceof CwmValidationError &&
      error.message.includes("$.regions.r.objectIds[0]"),
  );

  const bounded = validateCwmWorkspace(validated, { maxObjects: 0 });
  assert.equal(bounded.ok, false);
  assert.match(bounded.errors[0].message, /at most 0 entries/);
});

test("event validation rejects malformed and oversized transactions", () => {
  const malformed = validateCwmEvent(
    {
      id: "event",
      workspaceId: "board",
      sequence: 1,
      kind: "COMPENSATION_APPLIED",
      actor,
      actionClass: "MECHANICAL",
      occurredAt: "not-a-date",
      operations: [opSetFocus(null), opSetFocus(null)],
    },
    { maxOperationsPerEvent: 1 },
  );
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.some((issue) => issue.path === "$.occurredAt"));
  assert.ok(malformed.errors.some((issue) => issue.path === "$.operations"));
  assert.ok(malformed.errors.some((issue) => issue.path === "$.compensatesEventId"));
});
