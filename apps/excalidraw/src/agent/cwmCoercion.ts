import {
  CWM_MODES,
  CWM_OBJECT_KINDS,
  CWM_RELATION_KINDS,
  assertValidCwmOperation,
  type CwmFocus,
  type CwmObjectKind,
  type CwmProvenance,
  type CwmProvenanceKind,
  type CwmSemanticOperation,
  type CwmWorkspace,
} from "@joshu/whiteboard-cwm";

type UnknownRecord = Record<string, unknown>;

const MAX_ITEMS = 40;
const MAX_TEXT = 20_000;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function text(value: unknown, label: string, required = true): string {
  const result = typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
  if (required && !result) throw new Error(`${label} must be a non-empty string`);
  return result;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as UnknownRecord)
      : [];
  return values
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function objectList(value: unknown): UnknownRecord[] {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as UnknownRecord)
      : [];
  return values.filter(
    (entry): entry is UnknownRecord =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  ).slice(0, MAX_ITEMS);
}

function safeId(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function provenanceKind(value: unknown, hasUri: boolean): CwmProvenanceKind {
  const allowed = [
    "HUMAN_INPUT",
    "BOARD_OBJECT",
    "URI",
    "FILE",
    "MEMORY",
    "CONVERSATION",
    "AGENT_INFERENCE",
  ] as const;
  return typeof value === "string" && allowed.includes(value as (typeof allowed)[number])
    ? (value as CwmProvenanceKind)
    : hasUri
      ? "URI"
      : "BOARD_OBJECT";
}

function coerceProvenance(
  value: unknown,
  now: string,
  prefix: string,
): CwmProvenance[] {
  return objectList(value).map((entry, index) => {
    const sourceUri = text(entry.sourceUri, `${prefix}[${index}].sourceUri`, false);
    const sourceId = text(entry.sourceId, `${prefix}[${index}].sourceId`, false);
    if (!sourceUri && !sourceId) {
      throw new Error(`${prefix}[${index}] must include sourceUri or sourceId`);
    }
    const confidence =
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : undefined;
    return {
      id: safeId(entry.id, `${prefix}-${index + 1}`),
      kind: provenanceKind(entry.kind, Boolean(sourceUri)),
      ...(sourceId ? { sourceId: sourceId.slice(0, 128) } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      ...(text(entry.locator, "locator", false)
        ? { locator: text(entry.locator, "locator", false) }
        : {}),
      ...(text(entry.excerpt, "excerpt", false)
        ? { excerpt: text(entry.excerpt, "excerpt", false) }
        : {}),
      capturedBy: "AI",
      capturedAt: now,
      ...(confidence === undefined ? {} : { confidence }),
    };
  });
}

function openingSummary(brief: UnknownRecord): string {
  const explicit = text(brief.summary, "brief.summary", false);
  const sections = [
    ["What changed", stringList(brief.whatChanged)],
    ["Tensions", stringList(brief.tensions)],
    ["Open questions", stringList(brief.openQuestions)],
    ["Possible starts", stringList(brief.starts).slice(0, 3)],
  ] as const;
  const rendered = sections
    .filter(([, values]) => values.length > 0)
    .map(([heading, values]) => `${heading}:\n${values.map((item) => `- ${item}`).join("\n")}`)
    .join("\n\n");
  const summary = [explicit, rendered].filter(Boolean).join("\n\n").slice(0, MAX_TEXT);
  if (!summary) throw new Error("brief must contain a summary or grounded opening sections");
  return summary;
}

export function coerceStageOpening(
  args: UnknownRecord,
  now = new Date().toISOString(),
): readonly CwmSemanticOperation[] {
  const brief = record(args.brief, "brief");
  const sourceEntries = objectList(args.sources);
  const timestampId = now.replace(/\D/g, "").slice(0, 17) || "session";
  const sourceOperations = sourceEntries.map<CwmSemanticOperation>((source, index) => {
    const sourceUri = text(source.sourceUri, `sources[${index}].sourceUri`, false);
    const sourceId = text(source.sourceId, `sources[${index}].sourceId`, false);
    if (!sourceUri && !sourceId) {
      throw new Error(`sources[${index}] must include sourceUri or sourceId`);
    }
    const id = `source-${timestampId}-${safeId(source.id ?? source.title, "card")}-${index + 1}`.slice(
      0,
      128,
    );
    const body = text(source.body ?? source.excerpt, `sources[${index}].body`);
    const provenance: CwmProvenance = {
      id: `provenance-${id}`.slice(0, 128),
      kind: provenanceKind(source.kind, Boolean(sourceUri)),
      ...(sourceId ? { sourceId: sourceId.slice(0, 128) } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      excerpt: text(source.excerpt ?? source.body, "source excerpt", false).slice(0, 480),
      capturedBy: "AI",
      capturedAt: now,
    };
    return assertValidCwmOperation({
      type: "UPSERT_OBJECT",
      object: {
        id,
        kind: "Source",
        layer: "EVIDENCE",
        status: "PROPOSED",
        title: text(source.title, `sources[${index}].title`, false) || body.slice(0, 120),
        body,
        createdBy: "AI",
        createdAt: now,
        updatedAt: now,
        provenance: [provenance],
      },
    });
  });

  return [
    ...sourceOperations,
    assertValidCwmOperation({
      type: "SET_OPENING_BRIEF",
      openingBrief: {
        summary: openingSummary(brief),
        sourceObjectIds: sourceOperations.map(
          (operation) => operation.type === "UPSERT_OBJECT" ? operation.object.id : "",
        ).filter(Boolean),
        preparedBy: "AI",
        preparedAt: now,
      },
    }),
  ];
}

/**
 * Prefer nested `operation.object`. Recover flat hallucinations such as
 * `{ type:"UPSERT_OBJECT", text:"...", id:"sticky-1" }` (no nested object).
 */
function resolveObjectInput(operation: UnknownRecord, index: number): UnknownRecord {
  if (operation.object && typeof operation.object === "object" && !Array.isArray(operation.object)) {
    return operation.object as UnknownRecord;
  }
  const flatBody = text(
    operation.body ?? operation.text ?? operation.content ?? operation.note,
    `operations[${index}].body`,
    false,
  );
  if (!flatBody) {
    throw new Error(`operations[${index}].object must be an object`);
  }
  return {
    id: operation.id,
    kind: operation.kind ?? "Comment",
    layer: operation.layer ?? "SENSEMAKING",
    title: operation.title ?? flatBody.split("\n")[0]?.slice(0, 120),
    body: flatBody,
    provenance: operation.provenance,
    tags: operation.tags,
  };
}

function coerceObjectOperation(
  operation: UnknownRecord,
  now: string,
  index: number,
): CwmSemanticOperation {
  const input = resolveObjectInput(operation, index);
  if (input.layer === "COMMITMENT") {
    throw new Error("AI transactions cannot create commitment-layer objects");
  }
  const kind = CWM_OBJECT_KINDS.includes(input.kind as CwmObjectKind)
    ? (input.kind as CwmObjectKind)
    : "Comment";
  let provenance = coerceProvenance(input.provenance, now, `provenance-${index + 1}`);
  // Conversation-grounded sticky notes may omit provenance; default to an explicit chat source.
  if (!provenance.length) {
    const body = text(input.body, "object.body", false);
    provenance = [
      {
        id: `provenance-conversation-${index + 1}`,
        kind: "CONVERSATION",
        sourceId: "conversation",
        excerpt: (body || text(input.title, "object.title", false) || "chat").slice(0, 480),
        capturedBy: "AI",
        capturedAt: now,
      },
    ];
  }
  return {
    type: "UPSERT_OBJECT",
    object: {
      id: safeId(input.id, `ai-object-${index + 1}`),
      kind,
      layer: input.layer === "EVIDENCE" ? "EVIDENCE" : "SENSEMAKING",
      status: "PROPOSED",
      title: text(input.title, "object.title", false),
      body: text(input.body, "object.body"),
      createdBy: "AI",
      createdAt: now,
      updatedAt: now,
      provenance,
      ...(Array.isArray(input.tags)
        ? { tags: stringList(input.tags).map((tag) => safeId(tag, "tag")).slice(0, 64) }
        : {}),
    },
  };
}

/**
 * Accept the correct CWM transaction shape, or recover common model hallucinations
 * such as `{ type: "add_note", content: "..." }` into one PROPOSED Comment.
 */
function normalizeTransactionArgs(args: UnknownRecord): UnknownRecord {
  if (!args.transaction || typeof args.transaction !== "object" || Array.isArray(args.transaction)) {
    return args;
  }
  const transaction = args.transaction as UnknownRecord;
  if (Array.isArray(transaction.operations) && transaction.operations.length) {
    return args;
  }

  const content = text(
    transaction.content ?? transaction.body ?? transaction.text ?? transaction.note,
    "transaction.content",
    false,
  );
  if (!content) return args;

  const title =
    text(transaction.title, "transaction.title", false) ||
    (typeof transaction.type === "string" && transaction.type !== "add_note"
      ? text(transaction.type, "transaction.type", false)
      : "");

  return {
    transaction: {
      rationale:
        text(transaction.rationale, "transaction.rationale", false) ||
        "AI proposed sticky note from conversation",
      operations: [
        {
          type: "UPSERT_OBJECT",
          object: {
            kind: "Comment",
            layer: "SENSEMAKING",
            title: title || content.split("\n")[0]?.slice(0, 120) || "Sticky note",
            body: content,
            provenance: [
              {
                kind: "CONVERSATION",
                sourceId: "conversation",
                excerpt: content.slice(0, 480),
              },
            ],
          },
        },
      ],
    },
  };
}

export function coerceAgentTransaction(
  args: UnknownRecord,
  now = new Date().toISOString(),
): { readonly rationale: string; readonly operations: readonly CwmSemanticOperation[] } {
  const normalizedArgs = normalizeTransactionArgs(args);
  const transaction = record(normalizedArgs.transaction, "transaction");
  const rawOperations = Array.isArray(transaction.operations) ? transaction.operations : [];
  if (!rawOperations.length) {
    throw new Error(
      "transaction.operations must be a non-empty array of UPSERT_OBJECT/UPSERT_RELATION/UPSERT_REGION/SET_MODE/SET_OPENING_BRIEF ops (not add_note/content)",
    );
  }
  if (rawOperations.length > MAX_ITEMS) throw new Error(`transaction has more than ${MAX_ITEMS} operations`);

  const operations = rawOperations.map((raw, index) => {
    const operation = record(raw, `operations[${index}]`);
    let coerced: CwmSemanticOperation;
    switch (operation.type) {
      case "UPSERT_OBJECT":
        coerced = coerceObjectOperation(operation, now, index);
        break;
      case "UPSERT_RELATION": {
        const relation = record(operation.relation, `operations[${index}].relation`);
        const provenance = coerceProvenance(
          relation.provenance,
          now,
          `relation-provenance-${index + 1}`,
        );
        if (!provenance.length) {
          throw new Error(`operations[${index}].relation requires source-linked provenance`);
        }
        coerced = {
          type: "UPSERT_RELATION",
          relation: {
            id: safeId(relation.id, `ai-relation-${index + 1}`),
            kind: CWM_RELATION_KINDS.includes(
              relation.kind as (typeof CWM_RELATION_KINDS)[number],
            )
              ? (relation.kind as (typeof CWM_RELATION_KINDS)[number])
              : "RELATES_TO",
            source: record(relation.source, "relation.source") as { kind: "OBJECT" | "REGION"; id: string },
            target: record(relation.target, "relation.target") as { kind: "OBJECT" | "REGION"; id: string },
            status: "PROPOSED",
            label: text(relation.label, "relation.label", false),
            createdBy: "AI",
            createdAt: now,
            provenance,
          },
        };
        break;
      }
      case "UPSERT_REGION": {
        const region = record(operation.region, `operations[${index}].region`);
        const bounds = record(region.bounds, "region.bounds");
        coerced = {
          type: "UPSERT_REGION",
          region: {
            id: safeId(region.id, `ai-region-${index + 1}`),
            title: text(region.title, "region.title"),
            status: "PROPOSED",
            bounds: {
              x: Number(bounds.x),
              y: Number(bounds.y),
              width: Number(bounds.width),
              height: Number(bounds.height),
            },
            objectIds: stringList(region.objectIds).map((id) => safeId(id, "object")),
            createdBy: "AI",
            createdAt: now,
          },
        };
        break;
      }
      case "SET_MODE":
        if (!CWM_MODES.includes(operation.mode as (typeof CWM_MODES)[number])) {
          throw new Error(`operations[${index}].mode is invalid`);
        }
        if (operation.mode === "COMMIT") {
          throw new Error("AI transactions cannot enter COMMIT mode");
        }
        coerced = { type: "SET_MODE", mode: operation.mode as (typeof CWM_MODES)[number] };
        break;
      case "SET_OPENING_BRIEF": {
        const brief = record(operation.openingBrief, `operations[${index}].openingBrief`);
        coerced = {
          type: "SET_OPENING_BRIEF",
          openingBrief: {
            summary: text(brief.summary, "openingBrief.summary"),
            sourceObjectIds: stringList(brief.sourceObjectIds).map((id) => safeId(id, "source")),
            preparedBy: "AI",
            preparedAt: now,
          },
        };
        break;
      }
      default:
        throw new Error(
          `operations[${index}].type is not agent-safe; removal, focus, commitment, and scene binding are forbidden`,
        );
    }
    return assertValidCwmOperation(coerced);
  });

  return {
    rationale: text(transaction.rationale, "transaction.rationale"),
    operations,
  };
}

export function coerceAgentFocus(value: unknown, workspace: CwmWorkspace): CwmFocus {
  // Models sometimes pass a bare id string instead of { objectIds, regionIds }.
  if (typeof value === "string") {
    const id = value.trim();
    if (workspace.objects[id]) return { objectIds: [id], regionIds: [] };
    if (workspace.regions[id]) return { objectIds: [], regionIds: [id] };
    throw new Error(
      `focus "${id}" does not match an existing CWM object or region; pass { objectIds:[], regionIds:[] }`,
    );
  }
  const focus = record(value, "focus");
  const objectIds = stringList(focus.objectIds).filter((id) => Boolean(workspace.objects[id]));
  const regionIds = stringList(focus.regionIds).filter((id) => Boolean(workspace.regions[id]));
  if (!objectIds.length && !regionIds.length) {
    throw new Error("focus must reference at least one existing object or region");
  }
  return {
    objectIds,
    regionIds,
    ...(text(focus.reason, "focus.reason", false)
      ? { reason: text(focus.reason, "focus.reason", false) }
      : {}),
  };
}
