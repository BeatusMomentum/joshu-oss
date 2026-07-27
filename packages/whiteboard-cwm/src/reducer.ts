import { applyCwmOperation, applyCwmOperations } from "./operations.js";
import { getAuthorityPolicy } from "./policy.js";
import type {
  CwmActor,
  CwmEvent,
  CwmFocus,
  CwmProposal,
  CwmSemanticOperation,
  CwmWorkspace,
} from "./types.js";

function requireProposal(workspace: CwmWorkspace, proposalId: string | undefined): CwmProposal {
  if (proposalId === undefined) {
    throw new Error("Proposal event is missing proposalId");
  }
  const proposal = workspace.proposals[proposalId];
  if (proposal === undefined) {
    throw new Error(`Proposal "${proposalId}" does not exist`);
  }
  return proposal;
}

function resolveProposal(
  proposal: CwmProposal,
  status: "CONFIRMED" | "REJECTED",
  event: CwmEvent,
): CwmProposal {
  if (proposal.status !== "PENDING") {
    throw new Error(`Proposal "${proposal.id}" is already ${proposal.status}`);
  }
  return {
    ...proposal,
    status,
    resolvedAt: event.occurredAt,
    resolvedBy: event.actor,
  };
}

/**
 * Materialize one append-only event. Sequence checks prevent accidental gaps, duplication, and
 * cross-board replay.
 */
export function reduceCwmWorkspace(workspace: CwmWorkspace, event: CwmEvent): CwmWorkspace {
  if (event.workspaceId !== workspace.id) {
    throw new Error(
      `Event workspace "${event.workspaceId}" does not match workspace "${workspace.id}"`,
    );
  }
  const expectedSequence = workspace.headSequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(`Expected event sequence ${expectedSequence}, received ${event.sequence}`);
  }

  let next = workspace;
  switch (event.kind) {
    case "OPERATIONS_APPLIED": {
      const policy = getAuthorityPolicy(event.actionClass);
      if (!policy.appliesImmediately) {
        throw new Error(
          `${event.actionClass} operations cannot be applied without proposal confirmation`,
        );
      }
      if (policy.reversible && event.inverseOperations === undefined) {
        throw new Error(`${event.actionClass} event is missing inverseOperations`);
      }
      next = applyCwmOperations(next, event.operations);
      break;
    }
    case "PROPOSAL_CREATED": {
      if (event.proposal === undefined) {
        throw new Error("PROPOSAL_CREATED event is missing proposal");
      }
      if (event.proposal.workspaceId !== workspace.id) {
        throw new Error(`Proposal "${event.proposal.id}" belongs to a different workspace`);
      }
      if (workspace.proposals[event.proposal.id] !== undefined) {
        throw new Error(`Proposal "${event.proposal.id}" already exists`);
      }
      next = {
        ...next,
        proposals: { ...next.proposals, [event.proposal.id]: event.proposal },
      };
      break;
    }
    case "PROPOSAL_CONFIRMED": {
      const proposal = requireProposal(next, event.proposalId);
      const operations = event.operations.length > 0 ? event.operations : proposal.operations;
      next = applyCwmOperations(next, operations);
      next = {
        ...next,
        proposals: {
          ...next.proposals,
          [proposal.id]: resolveProposal(proposal, "CONFIRMED", event),
        },
      };
      break;
    }
    case "PROPOSAL_REJECTED": {
      const proposal = requireProposal(next, event.proposalId);
      if (event.operations.length > 0) {
        throw new Error("PROPOSAL_REJECTED event cannot contain operations");
      }
      next = {
        ...next,
        proposals: {
          ...next.proposals,
          [proposal.id]: resolveProposal(proposal, "REJECTED", event),
        },
      };
      break;
    }
    case "COMPENSATION_APPLIED":
      if (event.compensatesEventId === undefined) {
        throw new Error("COMPENSATION_APPLIED event is missing compensatesEventId");
      }
      next = applyCwmOperations(next, event.operations);
      break;
    default: {
      const exhaustive: never = event.kind;
      return exhaustive;
    }
  }

  return { ...next, headSequence: event.sequence };
}

export interface ReplayCwmEventsOptions {
  readonly maxEvents?: number;
}

/** Replay events in supplied append order; the reducer enforces contiguous sequence numbers. */
export function replayCwmEvents(
  initialWorkspace: CwmWorkspace,
  events: readonly CwmEvent[],
  options: ReplayCwmEventsOptions = {},
): CwmWorkspace {
  const maxEvents = options.maxEvents ?? 10_000;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
    throw new Error("maxEvents must be a non-negative safe integer");
  }
  if (events.length > maxEvents) {
    throw new Error(`Event replay limit exceeded: ${events.length} > ${maxEvents}`);
  }
  return events.reduce(reduceCwmWorkspace, initialWorkspace);
}

function relationsForObject(
  workspace: CwmWorkspace,
  objectId: string,
): readonly CwmSemanticOperation[] {
  return Object.values(workspace.relations)
    .filter(
      (relation) =>
        (relation.source.kind === "OBJECT" && relation.source.id === objectId) ||
        (relation.target.kind === "OBJECT" && relation.target.id === objectId),
    )
    .map((relation) => ({ type: "UPSERT_RELATION", relation }));
}

function relationsForRegion(
  workspace: CwmWorkspace,
  regionId: string,
): readonly CwmSemanticOperation[] {
  return Object.values(workspace.relations)
    .filter(
      (relation) =>
        (relation.source.kind === "REGION" && relation.source.id === regionId) ||
        (relation.target.kind === "REGION" && relation.target.id === regionId),
    )
    .map((relation) => ({ type: "UPSERT_RELATION", relation }));
}

function focusChangedByObject(focus: CwmFocus | null, objectId: string): boolean {
  return focus?.objectIds.includes(objectId) ?? false;
}

function focusChangedByRegion(focus: CwmFocus | null, regionId: string): boolean {
  return focus?.regionIds.includes(regionId) ?? false;
}

/** Derive the exact operation group needed to undo one operation against its before-state. */
export function deriveInverseOperation(
  workspace: CwmWorkspace,
  operation: CwmSemanticOperation,
): readonly CwmSemanticOperation[] {
  switch (operation.type) {
    case "UPSERT_OBJECT": {
      const previous = workspace.objects[operation.object.id];
      return previous === undefined
        ? [{ type: "REMOVE_OBJECT", objectId: operation.object.id }]
        : [{ type: "UPSERT_OBJECT", object: previous }];
    }
    case "REMOVE_OBJECT": {
      const previous = workspace.objects[operation.objectId];
      if (previous === undefined) return [];
      const affectedRegions = Object.values(workspace.regions)
        .filter((region) => region.objectIds.includes(operation.objectId))
        .map<CwmSemanticOperation>((region) => ({ type: "UPSERT_REGION", region }));
      const focusInverse: readonly CwmSemanticOperation[] = focusChangedByObject(
        workspace.focus,
        operation.objectId,
      )
        ? [{ type: "SET_FOCUS", focus: workspace.focus }]
        : [];
      const openingBriefInverse: readonly CwmSemanticOperation[] =
        workspace.openingBrief?.sourceObjectIds.includes(operation.objectId) === true
          ? [{ type: "SET_OPENING_BRIEF", openingBrief: workspace.openingBrief }]
          : [];
      return [
        { type: "UPSERT_OBJECT", object: previous },
        ...relationsForObject(workspace, operation.objectId),
        ...affectedRegions,
        ...focusInverse,
        ...openingBriefInverse,
      ];
    }
    case "UPSERT_RELATION": {
      const previous = workspace.relations[operation.relation.id];
      return previous === undefined
        ? [{ type: "REMOVE_RELATION", relationId: operation.relation.id }]
        : [{ type: "UPSERT_RELATION", relation: previous }];
    }
    case "REMOVE_RELATION": {
      const previous = workspace.relations[operation.relationId];
      return previous === undefined ? [] : [{ type: "UPSERT_RELATION", relation: previous }];
    }
    case "UPSERT_REGION": {
      const previous = workspace.regions[operation.region.id];
      return previous === undefined
        ? [{ type: "REMOVE_REGION", regionId: operation.region.id }]
        : [{ type: "UPSERT_REGION", region: previous }];
    }
    case "REMOVE_REGION": {
      const previous = workspace.regions[operation.regionId];
      if (previous === undefined) return [];
      const focusInverse: readonly CwmSemanticOperation[] = focusChangedByRegion(
        workspace.focus,
        operation.regionId,
      )
        ? [{ type: "SET_FOCUS", focus: workspace.focus }]
        : [];
      return [
        { type: "UPSERT_REGION", region: previous },
        ...relationsForRegion(workspace, operation.regionId),
        ...focusInverse,
      ];
    }
    case "SET_MODE":
      return [{ type: "SET_MODE", mode: workspace.mode }];
    case "SET_FOCUS":
      return [{ type: "SET_FOCUS", focus: workspace.focus }];
    case "SET_OPENING_BRIEF":
      return [{ type: "SET_OPENING_BRIEF", openingBrief: workspace.openingBrief }];
    case "SET_SCENE_BINDING": {
      const object = workspace.objects[operation.objectId];
      if (object === undefined) {
        throw new Error(
          `Cannot derive scene-binding inverse: object "${operation.objectId}" does not exist`,
        );
      }
      return [
        {
          type: "SET_SCENE_BINDING",
          objectId: operation.objectId,
          binding: object.sceneBinding ?? null,
        },
      ];
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/**
 * Derive a transaction inverse while simulating each forward operation. Inverse groups are
 * prepended so the resulting transaction executes in reverse order.
 */
export function deriveInverseOperations(
  workspaceBefore: CwmWorkspace,
  operations: readonly CwmSemanticOperation[],
): readonly CwmSemanticOperation[] {
  let current = workspaceBefore;
  let inverse: readonly CwmSemanticOperation[] = [];
  for (const operation of operations) {
    inverse = [...deriveInverseOperation(current, operation), ...inverse];
    current = applyCwmOperation(current, operation);
  }
  return inverse;
}

export interface CreateCompensatingEventInput {
  readonly id: string;
  readonly sequence: number;
  readonly actor: CwmActor;
  readonly occurredAt: string;
  readonly reason?: string;
}

/**
 * Construct, but do not apply, an append-only compensating event. The caller supplies the
 * original event's before-state only as a fallback for older events lacking stored inverses.
 */
export function createCompensatingEvent(
  originalEvent: CwmEvent,
  workspaceBeforeOriginalEvent: CwmWorkspace,
  input: CreateCompensatingEventInput,
): CwmEvent {
  if (
    originalEvent.kind !== "OPERATIONS_APPLIED" &&
    originalEvent.kind !== "PROPOSAL_CONFIRMED"
  ) {
    throw new Error(`Event kind ${originalEvent.kind} does not materialize compensable operations`);
  }
  const operations =
    originalEvent.inverseOperations ??
    deriveInverseOperations(workspaceBeforeOriginalEvent, originalEvent.operations);
  if (operations.length === 0) {
    throw new Error(`Event "${originalEvent.id}" has no materialized change to compensate`);
  }

  return {
    id: input.id,
    workspaceId: originalEvent.workspaceId,
    sequence: input.sequence,
    kind: "COMPENSATION_APPLIED",
    actor: input.actor,
    actionClass: originalEvent.actionClass,
    occurredAt: input.occurredAt,
    operations,
    inverseOperations: originalEvent.operations,
    compensatesEventId: originalEvent.id,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}
