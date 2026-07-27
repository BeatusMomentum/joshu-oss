import type {
  CwmActionClass,
  CwmAuthorityDecision,
  CwmSemanticOperation,
  CwmWorkspace,
} from "./types.js";

const AUTHORITY_POLICY: Readonly<Record<CwmActionClass, CwmAuthorityDecision>> = {
  EPHEMERAL: {
    actionClass: "EPHEMERAL",
    disposition: "APPLY_IMMEDIATELY",
    appliesImmediately: true,
    reversible: false,
    remainsProposed: false,
    requiresConfirmation: false,
  },
  MECHANICAL: {
    actionClass: "MECHANICAL",
    disposition: "APPLY_REVERSIBLY",
    appliesImmediately: true,
    reversible: true,
    remainsProposed: false,
    requiresConfirmation: false,
  },
  ORGANIZATIONAL: {
    actionClass: "ORGANIZATIONAL",
    disposition: "STAGE_PROPOSAL",
    appliesImmediately: false,
    reversible: true,
    remainsProposed: true,
    requiresConfirmation: false,
  },
  EPISTEMIC: {
    actionClass: "EPISTEMIC",
    disposition: "REQUIRE_CONFIRMATION",
    appliesImmediately: false,
    reversible: true,
    remainsProposed: true,
    requiresConfirmation: true,
  },
  COMMITMENT: {
    actionClass: "COMMITMENT",
    disposition: "REQUIRE_CONFIRMATION",
    appliesImmediately: false,
    reversible: true,
    remainsProposed: true,
    requiresConfirmation: true,
  },
};

/** Return the immutable authority rule for an action class. */
export function getAuthorityPolicy(actionClass: CwmActionClass): CwmAuthorityDecision {
  return AUTHORITY_POLICY[actionClass];
}

export const authorityPolicyFor = getAuthorityPolicy;

const ACTION_RANK: Readonly<Record<CwmActionClass, number>> = {
  EPHEMERAL: 0,
  MECHANICAL: 1,
  ORGANIZATIONAL: 2,
  EPISTEMIC: 3,
  COMMITMENT: 4,
};

/**
 * Conservatively classify a semantic operation. Callers may elevate an operation's class, but
 * should never downgrade the returned class.
 */
export function classifyCwmOperation(
  operation: CwmSemanticOperation,
  workspace?: CwmWorkspace,
): CwmActionClass {
  switch (operation.type) {
    case "SET_FOCUS":
      return "EPHEMERAL";
    case "SET_SCENE_BINDING":
      return "MECHANICAL";
    case "SET_MODE":
    case "UPSERT_REGION":
    case "REMOVE_REGION":
    case "UPSERT_RELATION":
    case "REMOVE_RELATION":
      return "ORGANIZATIONAL";
    case "SET_OPENING_BRIEF":
      return "EPISTEMIC";
    case "UPSERT_OBJECT":
      return operation.object.layer === "COMMITMENT" ? "COMMITMENT" : "EPISTEMIC";
    case "REMOVE_OBJECT": {
      const existing = workspace?.objects[operation.objectId];
      return existing?.layer === "COMMITMENT" ? "COMMITMENT" : "EPISTEMIC";
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/** Choose the strongest authority class in a transaction. */
export function classifyCwmOperations(
  operations: readonly CwmSemanticOperation[],
  workspace?: CwmWorkspace,
): CwmActionClass {
  let result: CwmActionClass = "EPHEMERAL";
  for (const operation of operations) {
    const candidate = classifyCwmOperation(operation, workspace);
    if (ACTION_RANK[candidate] > ACTION_RANK[result]) result = candidate;
  }
  return result;
}

/** Whether an event may materialize without a human confirmation step. */
export function canApplyWithoutConfirmation(actionClass: CwmActionClass): boolean {
  return getAuthorityPolicy(actionClass).appliesImmediately;
}
