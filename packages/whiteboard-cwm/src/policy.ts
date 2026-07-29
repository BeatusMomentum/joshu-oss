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
  // Kept for replaying older event logs; new classification no longer emits this class.
  ORGANIZATIONAL: {
    actionClass: "ORGANIZATIONAL",
    disposition: "APPLY_REVERSIBLY",
    appliesImmediately: true,
    reversible: true,
    remainsProposed: false,
    requiresConfirmation: false,
  },
  // Kept for replaying older event logs that staged notes/questions.
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
 * Kind-based authority for the local whiteboard session: everything applies immediately.
 * COMMITMENT/EPISTEMIC remain in the policy table only so older event logs still replay.
 */
export function classifyCwmOperation(
  operation: CwmSemanticOperation,
  workspace?: CwmWorkspace,
): CwmActionClass {
  void workspace;
  switch (operation.type) {
    case "SET_FOCUS":
      return "EPHEMERAL";
    case "SET_SCENE_BINDING":
    case "SET_MODE":
    case "UPSERT_REGION":
    case "REMOVE_REGION":
    case "UPSERT_RELATION":
    case "REMOVE_RELATION":
    case "SET_OPENING_BRIEF":
    case "UPSERT_OBJECT":
    case "REMOVE_OBJECT":
      return "MECHANICAL";
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
