/** Data-level layers keep source material, interpretation, and commitments distinct. */
export const CWM_LAYERS = ["EVIDENCE", "SENSEMAKING", "COMMITMENT"] as const;
export type CwmLayer = (typeof CWM_LAYERS)[number];

export const CWM_STATUSES = [
  "CAPTURED",
  "PROPOSED",
  "ENDORSED",
  "DISPUTED",
  "DECIDED",
  "ARCHIVED",
] as const;
export type CwmStatus = (typeof CWM_STATUSES)[number];

export const CWM_ACTORS = ["HUMAN", "AI", "EXTERNAL_SOURCE"] as const;
export type CwmActor = (typeof CWM_ACTORS)[number];
/** Backward-friendly vocabulary aliases for consumers that call the actor value a kind. */
export const CWM_ACTOR_KINDS = CWM_ACTORS;
export type CwmActorKind = CwmActor;

export const CWM_MODES = ["ORIENT", "CURATE", "DIVERGE", "CONVERGE", "COMMIT"] as const;
export type CwmMode = (typeof CWM_MODES)[number];

/**
 * A deliberately finite vocabulary. Applications may use `NOTE` for material that has not
 * yet earned a more specific semantic kind.
 */
export const CWM_OBJECT_KINDS = [
  "Source",
  "Extract",
  "Claim",
  "Question",
  "Hypothesis",
  "Cluster",
  "Option",
  "Decision",
  "Task",
  "Artifact",
  "Comment",
] as const;
export type CwmObjectKind = (typeof CWM_OBJECT_KINDS)[number];

export const CWM_PROVENANCE_KINDS = [
  "HUMAN_INPUT",
  "BOARD_OBJECT",
  "URI",
  "FILE",
  "MEMORY",
  "CONVERSATION",
  "AGENT_INFERENCE",
] as const;
export type CwmProvenanceKind = (typeof CWM_PROVENANCE_KINDS)[number];

export type CwmJsonPrimitive = string | number | boolean | null;
export type CwmJsonValue =
  | CwmJsonPrimitive
  | readonly CwmJsonValue[]
  | { readonly [key: string]: CwmJsonValue };

export interface CwmProvenance {
  readonly id: string;
  readonly kind: CwmProvenanceKind;
  readonly sourceId?: string;
  readonly sourceUri?: string;
  readonly locator?: string;
  readonly excerpt?: string;
  readonly capturedBy: CwmActor;
  /** ISO-8601 timestamp. */
  readonly capturedAt: string;
  /** A calibrated value from 0 through 1, when known. */
  readonly confidence?: number;
}

export interface CwmPoint {
  readonly x: number;
  readonly y: number;
}

/** Scene-independent geometry in board coordinates. */
export interface CwmGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Clockwise radians. */
  readonly rotation?: number;
  /** Optional local points for paths and pointer traces. */
  readonly points?: readonly CwmPoint[];
}

/**
 * The semantic sidecar owns meaning; this binding only connects that meaning to scene
 * elements. Element IDs are opaque to this package.
 */
export interface CwmSceneBinding {
  readonly elementIds: readonly string[];
  readonly primaryElementId?: string;
  readonly sceneVersion?: number;
}

export interface CwmObject {
  readonly id: string;
  readonly kind: CwmObjectKind;
  readonly layer: CwmLayer;
  readonly status: CwmStatus;
  readonly title?: string;
  readonly body: string;
  readonly createdBy: CwmActor;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp. */
  readonly updatedAt: string;
  readonly provenance: readonly CwmProvenance[];
  readonly geometry?: CwmGeometry;
  readonly sceneBinding?: CwmSceneBinding;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, CwmJsonValue>>;
}

export const CWM_RELATION_KINDS = [
  "SUPPORTS",
  "CONTRADICTS",
  "QUALIFIES",
  "DERIVES_FROM",
  "RESPONDS_TO",
  "DEPENDS_ON",
  "ENABLES",
  "BLOCKS",
  "RELATES_TO",
] as const;
export type CwmRelationKind = (typeof CWM_RELATION_KINDS)[number];

export const CWM_ENTITY_KINDS = ["OBJECT", "REGION"] as const;
export type CwmEntityKind = (typeof CWM_ENTITY_KINDS)[number];

export interface CwmEntityRef {
  readonly kind: CwmEntityKind;
  readonly id: string;
}

export interface CwmRelation {
  readonly id: string;
  readonly kind: CwmRelationKind;
  readonly source: CwmEntityRef;
  readonly target: CwmEntityRef;
  readonly status: CwmStatus;
  readonly label?: string;
  readonly createdBy: CwmActor;
  readonly createdAt: string;
  readonly provenance?: readonly CwmProvenance[];
  readonly metadata?: Readonly<Record<string, CwmJsonValue>>;
}

/** Soft spatial/semantic grouping; region membership does not change object identity. */
export interface CwmRegion {
  readonly id: string;
  readonly title: string;
  readonly layer?: CwmLayer;
  readonly status: CwmStatus;
  readonly bounds: CwmGeometry;
  readonly objectIds: readonly string[];
  readonly createdBy: CwmActor;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, CwmJsonValue>>;
}

export interface CwmFocus {
  readonly objectIds: readonly string[];
  readonly regionIds: readonly string[];
  readonly reason?: string;
}

export interface CwmOpeningBrief {
  readonly summary: string;
  readonly sourceObjectIds: readonly string[];
  readonly preparedBy: CwmActor;
  readonly preparedAt: string;
}

export const CWM_ACTION_CLASSES = [
  "EPHEMERAL",
  "MECHANICAL",
  "ORGANIZATIONAL",
  "EPISTEMIC",
  "COMMITMENT",
] as const;
export type CwmActionClass = (typeof CWM_ACTION_CLASSES)[number];

export const CWM_AUTHORITY_DISPOSITIONS = [
  "APPLY_IMMEDIATELY",
  "APPLY_REVERSIBLY",
  "STAGE_PROPOSAL",
  "REQUIRE_CONFIRMATION",
] as const;
export type CwmAuthorityDisposition = (typeof CWM_AUTHORITY_DISPOSITIONS)[number];

export interface CwmAuthorityDecision {
  readonly actionClass: CwmActionClass;
  readonly disposition: CwmAuthorityDisposition;
  readonly appliesImmediately: boolean;
  readonly reversible: boolean;
  readonly remainsProposed: boolean;
  readonly requiresConfirmation: boolean;
}

export type CwmSemanticOperation =
  | { readonly type: "UPSERT_OBJECT"; readonly object: CwmObject }
  | { readonly type: "REMOVE_OBJECT"; readonly objectId: string }
  | { readonly type: "UPSERT_RELATION"; readonly relation: CwmRelation }
  | { readonly type: "REMOVE_RELATION"; readonly relationId: string }
  | { readonly type: "UPSERT_REGION"; readonly region: CwmRegion }
  | { readonly type: "REMOVE_REGION"; readonly regionId: string }
  | { readonly type: "SET_MODE"; readonly mode: CwmMode }
  | { readonly type: "SET_FOCUS"; readonly focus: CwmFocus | null }
  | { readonly type: "SET_OPENING_BRIEF"; readonly openingBrief: CwmOpeningBrief | null }
  | {
      readonly type: "SET_SCENE_BINDING";
      readonly objectId: string;
      readonly binding: CwmSceneBinding | null;
    };

export const CWM_PROPOSAL_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type CwmProposalStatus = (typeof CWM_PROPOSAL_STATUSES)[number];

export interface CwmProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly proposedBy: CwmActor;
  readonly actionClass: CwmActionClass;
  readonly operations: readonly CwmSemanticOperation[];
  readonly rationale?: string;
  readonly status: CwmProposalStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: CwmActor;
}

export const CWM_EVENT_KINDS = [
  "OPERATIONS_APPLIED",
  "PROPOSAL_CREATED",
  "PROPOSAL_CONFIRMED",
  "PROPOSAL_REJECTED",
  "COMPENSATION_APPLIED",
] as const;
export type CwmEventKind = (typeof CWM_EVENT_KINDS)[number];

/**
 * Events are append-only. `inverseOperations` records the pre-application inverse when an
 * event changes materialized state, making compensation auditable and deterministic.
 */
export interface CwmEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly kind: CwmEventKind;
  readonly actor: CwmActor;
  readonly actionClass: CwmActionClass;
  readonly occurredAt: string;
  readonly operations: readonly CwmSemanticOperation[];
  readonly inverseOperations?: readonly CwmSemanticOperation[];
  readonly proposal?: CwmProposal;
  readonly proposalId?: string;
  readonly compensatesEventId?: string;
  readonly reason?: string;
}

export interface CwmWorkspace {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: CwmMode;
  readonly objects: Readonly<Record<string, CwmObject>>;
  readonly relations: Readonly<Record<string, CwmRelation>>;
  readonly regions: Readonly<Record<string, CwmRegion>>;
  readonly proposals: Readonly<Record<string, CwmProposal>>;
  readonly focus: CwmFocus | null;
  readonly openingBrief: CwmOpeningBrief | null;
  readonly headSequence: number;
}

export interface CwmLimits {
  readonly maxObjects: number;
  readonly maxRelations: number;
  readonly maxRegions: number;
  readonly maxProposals: number;
  readonly maxOperationsPerEvent: number;
  readonly maxEventsPerReplay: number;
  readonly maxTextLength: number;
  readonly maxIdLength: number;
  readonly maxProvenancePerObject: number;
  readonly maxBindingElementIds: number;
  readonly maxRegionObjectIds: number;
  readonly maxFocusEntityIds: number;
  readonly maxGeometryPoints: number;
  readonly maxTagsPerObject: number;
  readonly maxMetadataKeys: number;
}
