import {
  normalizeCwmObjectKind,
  normalizeCwmObjectRecord,
  normalizeCwmPhase,
  normalizeCwmWorkspace,
} from "./normalize.js";
import {
  CWM_ACTION_CLASSES,
  CWM_ACTORS,
  CWM_ENTITY_KINDS,
  CWM_EVENT_KINDS,
  CWM_MODES,
  CWM_OBJECT_KINDS,
  CWM_PHASES,
  CWM_PROPOSAL_STATUSES,
  CWM_PROVENANCE_KINDS,
  CWM_RELATION_KINDS,
  type CwmActor,
  type CwmEvent,
  type CwmFocus,
  type CwmGeometry,
  type CwmLimits,
  type CwmObject,
  type CwmOpeningBrief,
  type CwmProposal,
  type CwmProvenance,
  type CwmRegion,
  type CwmRelation,
  type CwmSceneBinding,
  type CwmSemanticOperation,
  type CwmWorkspace,
} from "./types.js";

export const CWM_DEFAULT_LIMITS: Readonly<CwmLimits> = Object.freeze({
  maxObjects: 500,
  maxRelations: 1_000,
  maxRegions: 100,
  maxProposals: 500,
  maxOperationsPerEvent: 200,
  maxEventsPerReplay: 10_000,
  maxTextLength: 20_000,
  maxIdLength: 128,
  maxProvenancePerObject: 32,
  maxBindingElementIds: 32,
  maxRegionObjectIds: 500,
  maxFocusEntityIds: 100,
  maxGeometryPoints: 1_000,
  maxTagsPerObject: 64,
  maxMetadataKeys: 100,
});

export interface CwmValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type CwmValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly CwmValidationIssue[] };

export class CwmValidationError extends Error {
  readonly issues: readonly CwmValidationIssue[];

  constructor(issues: readonly CwmValidationIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    super(`Invalid Curatorial Whiteboard data: ${detail}`);
    this.name = "CwmValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitsWith(overrides: Partial<CwmLimits> | undefined): CwmLimits {
  const limits = { ...CWM_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  return limits;
}

class Validator {
  readonly issues: CwmValidationIssue[] = [];

  constructor(readonly limits: CwmLimits) {}

  issue(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  record(value: unknown, path: string): UnknownRecord | null {
    if (!isRecord(value)) {
      this.issue(path, "must be an object");
      return null;
    }
    return value;
  }

  string(
    value: unknown,
    path: string,
    options: { id?: boolean; allowEmpty?: boolean } = {},
  ): value is string {
    if (typeof value !== "string") {
      this.issue(path, "must be a string");
      return false;
    }
    if (!options.allowEmpty && value.trim().length === 0) {
      this.issue(path, "must not be empty");
    }
    const limit = options.id ? this.limits.maxIdLength : this.limits.maxTextLength;
    if (value.length > limit) this.issue(path, `must be at most ${limit} characters`);
    return true;
  }

  optionalString(value: unknown, path: string, options = {}): void {
    if (value !== undefined) this.string(value, path, options);
  }

  enumeration(value: unknown, allowed: readonly string[], path: string): void {
    if (typeof value !== "string" || !allowed.includes(value)) {
      this.issue(path, `must be one of ${allowed.join(", ")}`);
    }
  }

  finite(value: unknown, path: string, minimum?: number): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.issue(path, "must be a finite number");
    } else if (minimum !== undefined && value < minimum) {
      this.issue(path, `must be at least ${minimum}`);
    }
  }

  integer(value: unknown, path: string, minimum = 0): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      this.issue(path, `must be a safe integer of at least ${minimum}`);
    }
  }

  timestamp(value: unknown, path: string): void {
    if (!this.string(value, path)) return;
    if (!Number.isFinite(Date.parse(value))) this.issue(path, "must be a valid ISO-8601 timestamp");
  }

  idArray(value: unknown, path: string, maximum: number): readonly string[] | null {
    if (!Array.isArray(value)) {
      this.issue(path, "must be an array");
      return null;
    }
    if (value.length > maximum) this.issue(path, `must contain at most ${maximum} IDs`);
    const seen = new Set<string>();
    value.forEach((id, index) => {
      if (this.string(id, `${path}[${index}]`, { id: true }) && typeof id === "string") {
        if (seen.has(id)) this.issue(`${path}[${index}]`, `duplicate ID "${id}"`);
        seen.add(id);
      }
    });
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  actor(value: unknown, path: string): void {
    this.enumeration(value, CWM_ACTORS, path);
  }

  json(value: unknown, path: string, depth = 0): void {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      if (typeof value === "string" && value.length > this.limits.maxTextLength) {
        this.issue(path, `must be at most ${this.limits.maxTextLength} characters`);
      }
      return;
    }
    if (depth >= 10) {
      this.issue(path, "must not exceed 10 nested levels");
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > this.limits.maxMetadataKeys) {
        this.issue(path, `must contain at most ${this.limits.maxMetadataKeys} entries`);
      }
      value.forEach((entry, index) => this.json(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      if (entries.length > this.limits.maxMetadataKeys) {
        this.issue(path, `must contain at most ${this.limits.maxMetadataKeys} keys`);
      }
      entries.forEach(([key, entry]) => {
        this.string(key, `${path} key`, { id: true });
        this.json(entry, `${path}.${key}`, depth + 1);
      });
      return;
    }
    this.issue(path, "must contain only finite JSON values");
  }

  geometry(value: unknown, path: string): void {
    const geometry = this.record(value, path);
    if (geometry === null) return;
    this.finite(geometry.x, `${path}.x`);
    this.finite(geometry.y, `${path}.y`);
    this.finite(geometry.width, `${path}.width`, 0);
    this.finite(geometry.height, `${path}.height`, 0);
    if (geometry.rotation !== undefined) this.finite(geometry.rotation, `${path}.rotation`);
    if (geometry.points !== undefined) {
      if (!Array.isArray(geometry.points)) {
        this.issue(`${path}.points`, "must be an array");
      } else {
        if (geometry.points.length > this.limits.maxGeometryPoints) {
          this.issue(
            `${path}.points`,
            `must contain at most ${this.limits.maxGeometryPoints} points`,
          );
        }
        geometry.points.forEach((point, index) => {
          const record = this.record(point, `${path}.points[${index}]`);
          if (record !== null) {
            this.finite(record.x, `${path}.points[${index}].x`);
            this.finite(record.y, `${path}.points[${index}].y`);
          }
        });
      }
    }
  }

  binding(value: unknown, path: string): void {
    const binding = this.record(value, path);
    if (binding === null) return;
    const ids = this.idArray(
      binding.elementIds,
      `${path}.elementIds`,
      this.limits.maxBindingElementIds,
    );
    if (ids !== null && ids.length === 0) {
      this.issue(`${path}.elementIds`, "must contain at least one element ID");
    }
    if (binding.primaryElementId !== undefined) {
      if (
        this.string(binding.primaryElementId, `${path}.primaryElementId`, { id: true }) &&
        ids !== null &&
        !ids.includes(binding.primaryElementId)
      ) {
        this.issue(`${path}.primaryElementId`, "must also appear in elementIds");
      }
    }
    if (binding.sceneVersion !== undefined) {
      this.integer(binding.sceneVersion, `${path}.sceneVersion`);
    }
  }

  provenance(value: unknown, path: string): void {
    const provenance = this.record(value, path);
    if (provenance === null) return;
    this.string(provenance.id, `${path}.id`, { id: true });
    this.enumeration(provenance.kind, CWM_PROVENANCE_KINDS, `${path}.kind`);
    this.optionalString(provenance.sourceId, `${path}.sourceId`, { id: true });
    this.optionalString(provenance.sourceUri, `${path}.sourceUri`);
    this.optionalString(provenance.locator, `${path}.locator`);
    this.optionalString(provenance.excerpt, `${path}.excerpt`, { allowEmpty: true });
    this.actor(provenance.capturedBy, `${path}.capturedBy`);
    this.timestamp(provenance.capturedAt, `${path}.capturedAt`);
    if (provenance.confidence !== undefined) {
      this.finite(provenance.confidence, `${path}.confidence`, 0);
      if (typeof provenance.confidence === "number" && provenance.confidence > 1) {
        this.issue(`${path}.confidence`, "must be at most 1");
      }
    }
  }

  object(value: unknown, path: string): void {
    const object = this.record(value, path);
    if (object === null) return;
    this.string(object.id, `${path}.id`, { id: true });
    const kind = normalizeCwmObjectKind(object.kind);
    if (!CWM_OBJECT_KINDS.includes(kind)) {
      this.issue(`${path}.kind`, `must be one of: ${CWM_OBJECT_KINDS.join(", ")}`);
    }
    const phase = normalizeCwmPhase(object.phase ?? object.status, {
      kind,
      layer: object.layer,
      status: object.status,
    });
    if (!CWM_PHASES.includes(phase)) {
      this.issue(`${path}.phase`, `must be one of: ${CWM_PHASES.join(", ")}`);
    }
    // Mutate the working record so assertValid returns normalized shape after parse.
    object.kind = kind;
    object.phase = phase;
    delete object.layer;
    delete object.status;
    this.optionalString(object.title, `${path}.title`, { allowEmpty: true });
    this.string(object.body, `${path}.body`, { allowEmpty: true });
    this.actor(object.createdBy, `${path}.createdBy`);
    this.timestamp(object.createdAt, `${path}.createdAt`);
    this.timestamp(object.updatedAt, `${path}.updatedAt`);
    if (!Array.isArray(object.provenance)) {
      this.issue(`${path}.provenance`, "must be an array");
    } else {
      if (object.provenance.length > this.limits.maxProvenancePerObject) {
        this.issue(
          `${path}.provenance`,
          `must contain at most ${this.limits.maxProvenancePerObject} records`,
        );
      }
      object.provenance.forEach((entry, index) =>
        this.provenance(entry, `${path}.provenance[${index}]`),
      );
    }
    if (object.geometry !== undefined) this.geometry(object.geometry, `${path}.geometry`);
    if (object.sceneBinding !== undefined) {
      this.binding(object.sceneBinding, `${path}.sceneBinding`);
    }
    if (object.tags !== undefined) {
      this.idArray(object.tags, `${path}.tags`, this.limits.maxTagsPerObject);
    }
    if (object.metadata !== undefined) this.json(object.metadata, `${path}.metadata`);
  }

  entityRef(value: unknown, path: string): void {
    const ref = this.record(value, path);
    if (ref === null) return;
    this.enumeration(ref.kind, CWM_ENTITY_KINDS, `${path}.kind`);
    this.string(ref.id, `${path}.id`, { id: true });
  }

  relation(value: unknown, path: string): void {
    const relation = this.record(value, path);
    if (relation === null) return;
    this.string(relation.id, `${path}.id`, { id: true });
    this.enumeration(relation.kind, CWM_RELATION_KINDS, `${path}.kind`);
    this.entityRef(relation.source, `${path}.source`);
    this.entityRef(relation.target, `${path}.target`);
    const phase = normalizeCwmPhase(relation.phase ?? relation.status);
    relation.phase = phase;
    delete relation.status;
    this.enumeration(relation.phase, CWM_PHASES, `${path}.phase`);
    this.optionalString(relation.label, `${path}.label`, { allowEmpty: true });    this.actor(relation.createdBy, `${path}.createdBy`);
    this.timestamp(relation.createdAt, `${path}.createdAt`);
    if (relation.provenance !== undefined) {
      if (!Array.isArray(relation.provenance)) {
        this.issue(`${path}.provenance`, "must be an array");
      } else {
        if (relation.provenance.length > this.limits.maxProvenancePerObject) {
          this.issue(
            `${path}.provenance`,
            `must contain at most ${this.limits.maxProvenancePerObject} records`,
          );
        }
        relation.provenance.forEach((entry, index) =>
          this.provenance(entry, `${path}.provenance[${index}]`),
        );
      }
    }
    if (relation.metadata !== undefined) this.json(relation.metadata, `${path}.metadata`);
  }

  region(value: unknown, path: string): void {
    const region = this.record(value, path);
    if (region === null) return;
    this.string(region.id, `${path}.id`, { id: true });
    this.string(region.title, `${path}.title`);
    const phase = normalizeCwmPhase(region.phase ?? region.status);
    region.phase = phase;
    delete region.layer;
    delete region.status;
    this.enumeration(region.phase, CWM_PHASES, `${path}.phase`);
    this.geometry(region.bounds, `${path}.bounds`);
    this.idArray(region.objectIds, `${path}.objectIds`, this.limits.maxRegionObjectIds);
    this.actor(region.createdBy, `${path}.createdBy`);
    this.timestamp(region.createdAt, `${path}.createdAt`);
    if (region.metadata !== undefined) this.json(region.metadata, `${path}.metadata`);
  }

  focus(value: unknown, path: string): void {
    const focus = this.record(value, path);
    if (focus === null) return;
    this.idArray(focus.objectIds, `${path}.objectIds`, this.limits.maxFocusEntityIds);
    this.idArray(focus.regionIds, `${path}.regionIds`, this.limits.maxFocusEntityIds);
    this.optionalString(focus.reason, `${path}.reason`, { allowEmpty: true });
  }

  openingBrief(value: unknown, path: string): void {
    const brief = this.record(value, path);
    if (brief === null) return;
    this.string(brief.summary, `${path}.summary`, { allowEmpty: true });
    this.idArray(
      brief.sourceObjectIds,
      `${path}.sourceObjectIds`,
      this.limits.maxFocusEntityIds,
    );
    this.actor(brief.preparedBy, `${path}.preparedBy`);
    this.timestamp(brief.preparedAt, `${path}.preparedAt`);
  }

  operation(value: unknown, path: string): void {
    const operation = this.record(value, path);
    if (operation === null) return;
    switch (operation.type) {
      case "UPSERT_OBJECT":
        this.object(operation.object, `${path}.object`);
        break;
      case "REMOVE_OBJECT":
        this.string(operation.objectId, `${path}.objectId`, { id: true });
        break;
      case "UPSERT_RELATION":
        this.relation(operation.relation, `${path}.relation`);
        break;
      case "REMOVE_RELATION":
        this.string(operation.relationId, `${path}.relationId`, { id: true });
        break;
      case "UPSERT_REGION":
        this.region(operation.region, `${path}.region`);
        break;
      case "REMOVE_REGION":
        this.string(operation.regionId, `${path}.regionId`, { id: true });
        break;
      case "SET_MODE":
        this.enumeration(operation.mode, CWM_MODES, `${path}.mode`);
        break;
      case "SET_FOCUS":
        if (operation.focus !== null) this.focus(operation.focus, `${path}.focus`);
        break;
      case "SET_OPENING_BRIEF":
        if (operation.openingBrief !== null) {
          this.openingBrief(operation.openingBrief, `${path}.openingBrief`);
        }
        break;
      case "SET_SCENE_BINDING":
        this.string(operation.objectId, `${path}.objectId`, { id: true });
        if (operation.binding !== null) this.binding(operation.binding, `${path}.binding`);
        break;
      default:
        this.issue(
          `${path}.type`,
          "must be a recognized semantic operation type",
        );
    }
  }

  operations(value: unknown, path: string): void {
    if (!Array.isArray(value)) {
      this.issue(path, "must be an array");
      return;
    }
    if (value.length > this.limits.maxOperationsPerEvent) {
      this.issue(path, `must contain at most ${this.limits.maxOperationsPerEvent} operations`);
    }
    value.forEach((operation, index) => this.operation(operation, `${path}[${index}]`));
  }

  proposal(value: unknown, path: string): void {
    const proposal = this.record(value, path);
    if (proposal === null) return;
    this.string(proposal.id, `${path}.id`, { id: true });
    this.string(proposal.workspaceId, `${path}.workspaceId`, { id: true });
    this.actor(proposal.proposedBy, `${path}.proposedBy`);
    this.enumeration(proposal.actionClass, CWM_ACTION_CLASSES, `${path}.actionClass`);
    this.operations(proposal.operations, `${path}.operations`);
    if (Array.isArray(proposal.operations) && proposal.operations.length === 0) {
      this.issue(`${path}.operations`, "must contain at least one operation");
    }
    this.optionalString(proposal.rationale, `${path}.rationale`, { allowEmpty: true });
    this.enumeration(proposal.status, CWM_PROPOSAL_STATUSES, `${path}.status`);
    this.timestamp(proposal.createdAt, `${path}.createdAt`);
    if (proposal.resolvedAt !== undefined) {
      this.timestamp(proposal.resolvedAt, `${path}.resolvedAt`);
    }
    if (proposal.resolvedBy !== undefined) {
      this.actor(proposal.resolvedBy, `${path}.resolvedBy`);
    }
    if (
      proposal.status === "PENDING" &&
      (proposal.resolvedAt !== undefined || proposal.resolvedBy !== undefined)
    ) {
      this.issue(path, "pending proposal must not have resolution fields");
    }
    if (
      proposal.status !== undefined &&
      proposal.status !== "PENDING" &&
      (proposal.resolvedAt === undefined || proposal.resolvedBy === undefined)
    ) {
      this.issue(path, "resolved proposal must include resolvedAt and resolvedBy");
    }
  }

  event(value: unknown, path: string): void {
    const event = this.record(value, path);
    if (event === null) return;
    this.string(event.id, `${path}.id`, { id: true });
    this.string(event.workspaceId, `${path}.workspaceId`, { id: true });
    this.integer(event.sequence, `${path}.sequence`, 1);
    this.enumeration(event.kind, CWM_EVENT_KINDS, `${path}.kind`);
    this.actor(event.actor, `${path}.actor`);
    this.enumeration(event.actionClass, CWM_ACTION_CLASSES, `${path}.actionClass`);
    this.timestamp(event.occurredAt, `${path}.occurredAt`);
    this.operations(event.operations, `${path}.operations`);
    if (event.inverseOperations !== undefined) {
      this.operations(event.inverseOperations, `${path}.inverseOperations`);
    }
    if (event.proposal !== undefined) this.proposal(event.proposal, `${path}.proposal`);
    this.optionalString(event.proposalId, `${path}.proposalId`, { id: true });
    this.optionalString(event.compensatesEventId, `${path}.compensatesEventId`, { id: true });
    this.optionalString(event.reason, `${path}.reason`, { allowEmpty: true });

    if (event.kind === "PROPOSAL_CREATED" && event.proposal === undefined) {
      this.issue(`${path}.proposal`, "is required for PROPOSAL_CREATED");
    }
    if (
      (event.kind === "PROPOSAL_CONFIRMED" || event.kind === "PROPOSAL_REJECTED") &&
      event.proposalId === undefined
    ) {
      this.issue(`${path}.proposalId`, `is required for ${event.kind}`);
    }
    if (event.kind === "COMPENSATION_APPLIED" && event.compensatesEventId === undefined) {
      this.issue(`${path}.compensatesEventId`, "is required for COMPENSATION_APPLIED");
    }
    if (
      (event.kind === "OPERATIONS_APPLIED" ||
        event.kind === "PROPOSAL_CONFIRMED" ||
        event.kind === "COMPENSATION_APPLIED") &&
      event.actionClass !== "EPHEMERAL" &&
      event.inverseOperations === undefined
    ) {
      this.issue(
        `${path}.inverseOperations`,
        `is required for reversible ${String(event.actionClass)} events`,
      );
    }
    if (
      event.kind === "PROPOSAL_REJECTED" &&
      Array.isArray(event.operations) &&
      event.operations.length > 0
    ) {
      this.issue(`${path}.operations`, "must be empty for PROPOSAL_REJECTED");
    }
  }
}

function finish<T>(validator: Validator, value: unknown): CwmValidationResult<T> {
  return validator.issues.length === 0
    ? { ok: true, value: value as T, errors: [] }
    : { ok: false, errors: validator.issues };
}

export function validateCwmOperation(
  value: unknown,
  limitOverrides?: Partial<CwmLimits>,
): CwmValidationResult<CwmSemanticOperation> {
  const validator = new Validator(limitsWith(limitOverrides));
  if (isRecord(value) && value.type === "UPSERT_OBJECT" && isRecord(value.object)) {
    value.object = normalizeCwmObjectRecord(value.object as unknown as CwmObject) as unknown as UnknownRecord;
  }
  validator.operation(value, "$");
  return finish(validator, value);
}

export function validateCwmProposal(
  value: unknown,
  limitOverrides?: Partial<CwmLimits>,
): CwmValidationResult<CwmProposal> {
  const validator = new Validator(limitsWith(limitOverrides));
  validator.proposal(value, "$");
  return finish(validator, value);
}

export function validateCwmEvent(
  value: unknown,
  limitOverrides?: Partial<CwmLimits>,
): CwmValidationResult<CwmEvent> {
  const validator = new Validator(limitsWith(limitOverrides));
  validator.event(value, "$");
  return finish(validator, value);
}

function checkEntityRef(
  validator: Validator,
  workspace: UnknownRecord,
  refValue: unknown,
  path: string,
): void {
  if (!isRecord(refValue) || typeof refValue.id !== "string") return;
  if (refValue.kind === "OBJECT") {
    if (!isRecord(workspace.objects) || workspace.objects[refValue.id] === undefined) {
      validator.issue(path, `references missing object "${refValue.id}"`);
    }
  } else if (refValue.kind === "REGION") {
    if (!isRecord(workspace.regions) || workspace.regions[refValue.id] === undefined) {
      validator.issue(path, `references missing region "${refValue.id}"`);
    }
  }
}

function validateRecordCollection(
  validator: Validator,
  value: unknown,
  path: string,
  maximum: number,
  validateEntry: (entry: unknown, path: string) => void,
): UnknownRecord | null {
  const collection = validator.record(value, path);
  if (collection === null) return null;
  const entries = Object.entries(collection);
  if (entries.length > maximum) {
    validator.issue(path, `must contain at most ${maximum} entries`);
  }
  for (const [key, entry] of entries) {
    validator.string(key, `${path} key`, { id: true });
    validateEntry(entry, `${path}.${key}`);
    if (isRecord(entry) && entry.id !== key) {
      validator.issue(`${path}.${key}.id`, `must match record key "${key}"`);
    }
  }
  return collection;
}

export function validateCwmWorkspace(
  value: unknown,
  limitOverrides?: Partial<CwmLimits>,
): CwmValidationResult<CwmWorkspace> {
  // Migrate legacy kind/layer/status payloads before structural validation.
  const migrated =
    value && typeof value === "object" && !Array.isArray(value)
      ? normalizeCwmWorkspace(value as CwmWorkspace)
      : value;
  const validator = new Validator(limitsWith(limitOverrides));
  const workspace = validator.record(migrated, "$");
  if (workspace === null) return finish(validator, migrated);

  if (workspace.schemaVersion !== 1) {
    validator.issue("$.schemaVersion", "must equal 1");
  }
  validator.string(workspace.id, "$.id", { id: true });
  validator.enumeration(workspace.mode, CWM_MODES, "$.mode");
  validator.integer(workspace.headSequence, "$.headSequence");

  const objects = validateRecordCollection(
    validator,
    workspace.objects,
    "$.objects",
    validator.limits.maxObjects,
    (entry, path) => validator.object(entry, path),
  );
  const regions = validateRecordCollection(
    validator,
    workspace.regions,
    "$.regions",
    validator.limits.maxRegions,
    (entry, path) => validator.region(entry, path),
  );
  const relations = validateRecordCollection(
    validator,
    workspace.relations,
    "$.relations",
    validator.limits.maxRelations,
    (entry, path) => validator.relation(entry, path),
  );
  const proposals = validateRecordCollection(
    validator,
    workspace.proposals,
    "$.proposals",
    validator.limits.maxProposals,
    (entry, path) => validator.proposal(entry, path),
  );

  if (workspace.focus !== null) validator.focus(workspace.focus, "$.focus");
  if (workspace.openingBrief !== null) {
    validator.openingBrief(workspace.openingBrief, "$.openingBrief");
  }

  if (regions !== null && objects !== null) {
    for (const [regionId, regionValue] of Object.entries(regions)) {
      if (!isRecord(regionValue) || !Array.isArray(regionValue.objectIds)) continue;
      regionValue.objectIds.forEach((objectId, index) => {
        if (typeof objectId === "string" && objects[objectId] === undefined) {
          validator.issue(
            `$.regions.${regionId}.objectIds[${index}]`,
            `references missing object "${objectId}"`,
          );
        }
      });
    }
  }

  if (relations !== null) {
    for (const [relationId, relationValue] of Object.entries(relations)) {
      if (!isRecord(relationValue)) continue;
      checkEntityRef(
        validator,
        workspace,
        relationValue.source,
        `$.relations.${relationId}.source`,
      );
      checkEntityRef(
        validator,
        workspace,
        relationValue.target,
        `$.relations.${relationId}.target`,
      );
    }
  }

  if (isRecord(workspace.focus)) {
    if (objects !== null && Array.isArray(workspace.focus.objectIds)) {
      workspace.focus.objectIds.forEach((id, index) => {
        if (typeof id === "string" && objects[id] === undefined) {
          validator.issue(
            `$.focus.objectIds[${index}]`,
            `references missing object "${id}"`,
          );
        }
      });
    }
    if (regions !== null && Array.isArray(workspace.focus.regionIds)) {
      workspace.focus.regionIds.forEach((id, index) => {
        if (typeof id === "string" && regions[id] === undefined) {
          validator.issue(
            `$.focus.regionIds[${index}]`,
            `references missing region "${id}"`,
          );
        }
      });
    }
  }

  if (isRecord(workspace.openingBrief) && objects !== null) {
    const sourceIds = workspace.openingBrief.sourceObjectIds;
    if (Array.isArray(sourceIds)) {
      sourceIds.forEach((id, index) => {
        if (typeof id === "string" && objects[id] === undefined) {
          validator.issue(
            `$.openingBrief.sourceObjectIds[${index}]`,
            `references missing object "${id}"`,
          );
        }
      });
    }
  }

  if (proposals !== null) {
    for (const [proposalId, proposalValue] of Object.entries(proposals)) {
      if (
        isRecord(proposalValue) &&
        typeof workspace.id === "string" &&
        proposalValue.workspaceId !== workspace.id
      ) {
        validator.issue(
          `$.proposals.${proposalId}.workspaceId`,
          `must match workspace ID "${workspace.id}"`,
        );
      }
    }
  }

  return finish(validator, migrated);
}

function assertResult<T>(result: CwmValidationResult<T>): T {
  if (!result.ok) throw new CwmValidationError(result.errors);
  return result.value;
}

export const assertValidCwmOperation = (
  value: unknown,
  limits?: Partial<CwmLimits>,
): CwmSemanticOperation => assertResult(validateCwmOperation(value, limits));

export const assertValidCwmProposal = (
  value: unknown,
  limits?: Partial<CwmLimits>,
): CwmProposal => assertResult(validateCwmProposal(value, limits));

export const assertValidCwmEvent = (
  value: unknown,
  limits?: Partial<CwmLimits>,
): CwmEvent => assertResult(validateCwmEvent(value, limits));

export const assertValidCwmWorkspace = (
  value: unknown,
  limits?: Partial<CwmLimits>,
): CwmWorkspace => assertResult(validateCwmWorkspace(value, limits));

// Parse aliases make intent explicit at untrusted JSON boundaries.
export const parseCwmOperation = assertValidCwmOperation;
export const parseCwmProposal = assertValidCwmProposal;
export const parseCwmEvent = assertValidCwmEvent;
export const parseCwmWorkspace = assertValidCwmWorkspace;

// Exported type-only helpers document validator coverage for API consumers.
export type ValidatedCwmActor = CwmActor;
export type ValidatedCwmObject = CwmObject;
export type ValidatedCwmRelation = CwmRelation;
export type ValidatedCwmRegion = CwmRegion;
export type ValidatedCwmProvenance = CwmProvenance;
export type ValidatedCwmGeometry = CwmGeometry;
export type ValidatedCwmSceneBinding = CwmSceneBinding;
export type ValidatedCwmFocus = CwmFocus;
export type ValidatedCwmOpeningBrief = CwmOpeningBrief;
