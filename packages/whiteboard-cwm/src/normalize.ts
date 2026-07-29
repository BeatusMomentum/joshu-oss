import type {
  CwmObject,
  CwmObjectKind,
  CwmPhase,
  CwmProposal,
  CwmRegion,
  CwmRelation,
  CwmSemanticOperation,
  CwmWorkspace,
} from "./types.js";

const LEGACY_KIND_MAP: Readonly<Record<string, CwmObjectKind>> = {
  note: "note",
  open_question: "open_question",
  decision: "decision",
  Source: "note",
  Extract: "note",
  Claim: "note",
  Comment: "note",
  Hypothesis: "note",
  Cluster: "note",
  Option: "note",
  Artifact: "note",
  Question: "open_question",
  Decision: "decision",
  Task: "decision",
};

/**
 * Map any stored/agent kind string (including the old 11-kind vocabulary) onto the three
 * simplified kinds.
 */
export function normalizeCwmObjectKind(raw: unknown): CwmObjectKind {
  if (typeof raw !== "string") return "note";
  const mapped = LEGACY_KIND_MAP[raw];
  if (mapped) return mapped;
  const lower = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (lower === "open_question" || lower === "question") return "open_question";
  if (lower === "decision" || lower === "task" || lower === "commitment") return "decision";
  if (lower === "note" || lower === "comment" || lower === "source") return "note";
  return "note";
}

/** Infer a simplified phase from legacy status/layer or an explicit phase field. */
export function normalizeCwmPhase(
  raw: unknown,
  options: { readonly kind?: CwmObjectKind; readonly layer?: unknown; readonly status?: unknown } = {},
): CwmPhase {
  if (raw === "pending" || raw === "accepted" || raw === "dismissed") return raw;
  if (raw === "PENDING") return "pending";
  if (raw === "REJECTED" || raw === "WITHDRAWN" || raw === "ARCHIVED") return "dismissed";
  if (raw === "CONFIRMED" || raw === "DECIDED" || raw === "ENDORSED" || raw === "CAPTURED") {
    return "accepted";
  }
  if (options.status === "ARCHIVED") return "dismissed";
  if (options.status === "DISPUTED" || options.status === "PROPOSED") return "pending";
  if (options.status === "DECIDED" || options.status === "ENDORSED") return "accepted";
  if (options.layer === "COMMITMENT" || options.kind === "decision") {
    return options.status === "PROPOSED" ? "pending" : "accepted";
  }
  return "accepted";
}

function normalizeOperation(operation: CwmSemanticOperation): CwmSemanticOperation {
  if (operation.type !== "UPSERT_OBJECT") return operation;
  return {
    type: "UPSERT_OBJECT",
    object: normalizeCwmObjectRecord(operation.object),
  };
}

/** Normalize one object record, dropping legacy layer/status once phase/kind are set. */
export function normalizeCwmObjectRecord(object: CwmObject | Record<string, unknown>): CwmObject {
  const record = object as Record<string, unknown>;
  const kind = normalizeCwmObjectKind(record.kind);
  const phase = normalizeCwmPhase(record.phase, {
    kind,
    layer: record.layer,
    status: record.status,
  });
  const result: CwmObject = {
    id: String(record.id ?? ""),
    kind,
    phase,
    body: typeof record.body === "string" ? record.body : "",
    createdBy: (record.createdBy as CwmObject["createdBy"]) ?? "HUMAN",
    createdAt: String(record.createdAt ?? new Date().toISOString()),
    updatedAt: String(record.updatedAt ?? record.createdAt ?? new Date().toISOString()),
    provenance: Array.isArray(record.provenance)
      ? (record.provenance as CwmObject["provenance"])
      : [],
  };
  if (typeof record.title === "string") (result as { title?: string }).title = record.title;
  if (record.geometry && typeof record.geometry === "object") {
    (result as { geometry?: CwmObject["geometry"] }).geometry =
      record.geometry as CwmObject["geometry"];
  }
  if (record.sceneBinding && typeof record.sceneBinding === "object") {
    (result as { sceneBinding?: CwmObject["sceneBinding"] }).sceneBinding =
      record.sceneBinding as CwmObject["sceneBinding"];
  }
  if (Array.isArray(record.tags)) {
    (result as { tags?: readonly string[] }).tags = record.tags as readonly string[];
  }
  if (record.metadata && typeof record.metadata === "object") {
    (result as { metadata?: CwmObject["metadata"] }).metadata =
      record.metadata as CwmObject["metadata"];
  }
  return result;
}

function normalizeProposal(proposal: CwmProposal): CwmProposal {
  return {
    ...proposal,
    operations: proposal.operations.map(normalizeOperation),
  };
}

function normalizeRegion(region: CwmRegion | Record<string, unknown>): CwmRegion {
  const record = region as Record<string, unknown>;
  const result: CwmRegion = {
    id: String(record.id ?? ""),
    title: String(record.title ?? ""),
    phase: normalizeCwmPhase(record.phase ?? record.status),
    bounds: record.bounds as CwmRegion["bounds"],
    objectIds: Array.isArray(record.objectIds) ? (record.objectIds as readonly string[]) : [],
    createdBy: (record.createdBy as CwmRegion["createdBy"]) ?? "HUMAN",
    createdAt: String(record.createdAt ?? new Date().toISOString()),
  };
  if (record.metadata && typeof record.metadata === "object") {
    (result as { metadata?: CwmRegion["metadata"] }).metadata =
      record.metadata as CwmRegion["metadata"];
  }
  return result;
}

function normalizeRelation(relation: CwmRelation | Record<string, unknown>): CwmRelation {
  const record = relation as Record<string, unknown>;
  const result: CwmRelation = {
    id: String(record.id ?? ""),
    kind: record.kind as CwmRelation["kind"],
    source: record.source as CwmRelation["source"],
    target: record.target as CwmRelation["target"],
    phase: normalizeCwmPhase(record.phase ?? record.status),
    createdBy: (record.createdBy as CwmRelation["createdBy"]) ?? "HUMAN",
    createdAt: String(record.createdAt ?? new Date().toISOString()),
  };
  if (typeof record.label === "string") (result as { label?: string }).label = record.label;
  if (Array.isArray(record.provenance)) {
    (result as { provenance?: CwmRelation["provenance"] }).provenance =
      record.provenance as CwmRelation["provenance"];
  }
  if (record.metadata && typeof record.metadata === "object") {
    (result as { metadata?: CwmRelation["metadata"] }).metadata =
      record.metadata as CwmRelation["metadata"];
  }
  return result;
}

/**
 * One-shot load-time migration: rewrite legacy kinds/layers/statuses into kind + phase.
 * Safe to run repeatedly on already-normalized workspaces.
 */
export function normalizeCwmWorkspace(workspace: CwmWorkspace): CwmWorkspace {
  const objects: Record<string, CwmObject> = {};
  for (const [id, object] of Object.entries(workspace.objects ?? {})) {
    objects[id] = normalizeCwmObjectRecord(object);
  }
  const proposals: Record<string, CwmProposal> = {};
  for (const [id, proposal] of Object.entries(workspace.proposals ?? {})) {
    proposals[id] = normalizeProposal(proposal);
  }
  const regions: Record<string, CwmRegion> = {};
  for (const [id, region] of Object.entries(workspace.regions ?? {})) {
    regions[id] = normalizeRegion(region);
  }
  const relations: Record<string, CwmRelation> = {};
  for (const [id, relation] of Object.entries(workspace.relations ?? {})) {
    relations[id] = normalizeRelation(relation);
  }
  return {
    ...workspace,
    objects,
    proposals,
    regions,
    relations,
  };
}
