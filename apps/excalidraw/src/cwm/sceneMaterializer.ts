import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  CwmObject,
  CwmProposal,
  CwmRegion,
  CwmSceneBinding,
  CwmSemanticOperation,
  CwmWorkspace,
} from "@joshu/whiteboard-cwm";

interface CwmElementData {
  readonly objectId?: string;
  readonly regionId?: string;
  readonly proposalId?: string;
  readonly role: "card" | "text" | "region" | "removal" | "action_note";
  readonly preview: boolean;
  readonly previewText?: string;
  readonly finalElementId?: string;
}

export interface NormalizeOperationsOptions {
  /** Existing ordinary elements selected by the human for semantic promotion. */
  readonly bindingsByObjectId?: Readonly<Record<string, readonly string[]>>;
}

const metadata = (element: ExcalidrawElement): CwmElementData | null => {
  const value = (element.customData as { cwm?: unknown } | undefined)?.cwm;
  return typeof value === "object" && value !== null ? (value as CwmElementData) : null;
};

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function stableElementId(workspaceId: string, entityId: string, role: string): string {
  return `cwm-${role}-${stableHash(`${workspaceId}:${entityId}:${role}`)}`;
}

function generatedBinding(workspaceId: string, objectId: string): CwmSceneBinding {
  const card = stableElementId(workspaceId, objectId, "card");
  const text = stableElementId(workspaceId, objectId, "text");
  return { elementIds: [card, text], primaryElementId: card };
}

function elementReadableText(element: ExcalidrawElement): string {
  if (element.type === "text") {
    return String(
      (element as { originalText?: string; text?: string }).originalText ||
        (element as { text?: string }).text ||
        "",
    )
      .replace(/\s+/g, " ")
      .trim();
  }
  const preview = metadata(element)?.previewText;
  return typeof preview === "string" ? preview.replace(/\s+/g, " ").trim() : "";
}

/**
 * When CWM sceneBinding IDs were lost (refresh wiped materialized cards), place updates beside
 * ordinary stickies whose text still matches the object title/body.
 */
export function resolveObjectAnchorElements(
  object: CwmObject,
  scene: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  const bindingIds = object.sceneBinding?.elementIds ?? [];
  const bound = scene.filter((element) => bindingIds.includes(element.id) && !element.isDeleted);
  if (bound.length) return bound;

  const needles = [object.title, object.body.split("\n")[0], object.body]
    .map((value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter((value) => value.length >= 6);

  if (!needles.length) return [];

  const scored = scene
    .filter((element) => !element.isDeleted)
    .map((element) => {
      const text = elementReadableText(element).toLowerCase();
      if (!text) return { element, score: 0 };
      let score = 0;
      for (const needle of needles) {
        if (text.includes(needle.slice(0, Math.min(40, needle.length)))) score += 3;
        const token = needle.split(/[^a-z0-9]+/).find((part) => part.length >= 5);
        if (token && text.includes(token)) score += 1;
      }
      return { element, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) return [];
  const best = scored[0]!.element;
  // Prefer sticky container when a bound text matched.
  const containerId = (best as { containerId?: string | null }).containerId;
  if (containerId) {
    const container = scene.find((element) => element.id === containerId && !element.isDeleted);
    if (container) return [container, best];
  }
  return [best];
}

export function resolveObjectGeometry(
  object: CwmObject,
  workspaceId: string,
  scene: readonly ExcalidrawElement[],
): NonNullable<CwmObject["geometry"]> {
  if (object.geometry) return object.geometry;
  const anchored = resolveObjectAnchorElements(object, scene);
  if (anchored.length) {
    const minX = Math.min(...anchored.map((element) => element.x));
    const minY = Math.min(...anchored.map((element) => element.y));
    const maxX = Math.max(...anchored.map((element) => element.x + element.width));
    const maxY = Math.max(...anchored.map((element) => element.y + element.height));
    // Park the ghost/chip just to the right of the live sticky the user still sees.
    return {
      x: maxX + 28,
      y: minY,
      width: Math.max(200, maxX - minX),
      height: Math.max(100, maxY - minY),
    };
  }
  return defaultGeometry(workspaceId, object.id);
}

/**
 * Scene IDs are a client concern. Incoming object bindings are replaced with either the existing
 * sidecar binding, a human-selected ordinary-element binding, or deterministic generated IDs.
 */
export function normalizeSemanticOperations(
  operations: readonly CwmSemanticOperation[],
  workspace: CwmWorkspace,
  options: NormalizeOperationsOptions = {},
): readonly CwmSemanticOperation[] {
  return operations.map((operation): CwmSemanticOperation => {
    if (operation.type === "UPSERT_OBJECT") {
      const existing = workspace.objects[operation.object.id]?.sceneBinding;
      const selected = options.bindingsByObjectId?.[operation.object.id];
      const sceneBinding =
        existing ??
        (selected?.length
          ? { elementIds: [...selected], primaryElementId: selected[0] }
          : generatedBinding(workspace.id, operation.object.id));
      return {
        type: "UPSERT_OBJECT",
        object: { ...operation.object, sceneBinding },
      };
    }
    if (operation.type === "SET_SCENE_BINDING") {
      const existing = workspace.objects[operation.objectId]?.sceneBinding;
      return {
        ...operation,
        binding: existing ?? generatedBinding(workspace.id, operation.objectId),
      };
    }
    return operation;
  });
}

function elementBase(
  id: string,
  type: "rectangle" | "text",
  geometry: { x: number; y: number; width: number; height: number },
  data: CwmElementData,
): Record<string, unknown> {
  const seed = Number.parseInt(stableHash(id).slice(0, 7), 36) || 1;
  return {
    id,
    type,
    ...geometry,
    angle: 0,
    strokeColor: "#5f4b32",
    backgroundColor: "#fff7e8",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: data.preview ? "dashed" : "solid",
    roughness: 1,
    opacity: data.preview ? 45 : 100,
    roundness: { type: 3 },
    seed,
    version: 1,
    versionNonce: seed,
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: data.preview,
    customData: { cwm: data },
  };
}

const CARD_FONT_SIZE = 18;
const CARD_FONT_FAMILY = 1;
const CARD_LINE_HEIGHT = 1.25;
/** Match Excalidraw BOUND_TEXT_PADDING so bound sticky text sits correctly. */
const BOUND_TEXT_PADDING = 5;
const CARD_MIN_WIDTH = 240;
const CARD_MIN_HEIGHT = 90;
const CARD_PACK_COLS = 2;
const CARD_PACK_WIDTH = 280;
const CARD_PACK_COL_GAP = 36;
const CARD_PACK_ROW_GAP = 28;
const CARD_PACK_ORIGIN_X = 80;
const CARD_PACK_ORIGIN_Y = 80;

/**
 * Soft-wrap without canvas metrics so materialization works in Node tests and
 * still produces readable Excalidraw bound text on the canvas.
 */
function wrapPlainText(text: string, maxWidthPx: number, fontSize: number): string {
  const avgCharWidth = fontSize * 0.55;
  const maxChars = Math.max(12, Math.floor(maxWidthPx / avgCharWidth));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= maxChars) {
      lines.push(paragraph);
      continue;
    }
    let rest = paragraph;
    while (rest.length > maxChars) {
      let breakAt = rest.lastIndexOf(" ", maxChars);
      if (breakAt < Math.floor(maxChars * 0.4)) breakAt = maxChars;
      lines.push(rest.slice(0, breakAt).trimEnd());
      rest = rest.slice(breakAt).trimStart();
    }
    if (rest.length) lines.push(rest);
  }
  return lines.join("\n");
}

function measureWrappedTextHeight(wrapped: string, fontSize: number, lineHeight: number): number {
  const lineCount = Math.max(1, wrapped.split("\n").length);
  return Math.ceil(lineCount * fontSize * lineHeight);
}

/**
 * Agents often put the same string in title and body (or body already starts with
 * title). Never stamp that twice onto the sticky.
 */
export function composeCardText(title: string, body: string): string {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle) return trimmedBody;
  if (!trimmedBody) return trimmedTitle;
  if (trimmedTitle === trimmedBody) return trimmedBody;
  if (trimmedBody.startsWith(trimmedTitle)) return trimmedBody;
  return `${trimmedTitle}\n${trimmedBody}`;
}

function defaultGeometry(workspaceId: string, objectId: string): NonNullable<CwmObject["geometry"]> {
  // Fallback scatter when no pack slot is supplied. Height is recomputed from text.
  const hash = Number.parseInt(stableHash(`${workspaceId}:${objectId}`).slice(0, 7), 36);
  return {
    x: CARD_PACK_ORIGIN_X + (hash % CARD_PACK_COLS) * (CARD_PACK_WIDTH + CARD_PACK_COL_GAP),
    y: CARD_PACK_ORIGIN_Y + Math.floor(hash / CARD_PACK_COLS) * 280,
    width: CARD_PACK_WIDTH,
    height: CARD_MIN_HEIGHT,
  };
}

type CardPackCursor = {
  col: number;
  y: number;
  rowMaxHeight: number;
};

function createCardPackCursor(): CardPackCursor {
  return { col: 0, y: CARD_PACK_ORIGIN_Y, rowMaxHeight: 0 };
}

function nextPackedGeometry(pack: CardPackCursor): NonNullable<CwmObject["geometry"]> {
  return {
    x: CARD_PACK_ORIGIN_X + pack.col * (CARD_PACK_WIDTH + CARD_PACK_COL_GAP),
    y: pack.y,
    width: CARD_PACK_WIDTH,
    height: CARD_MIN_HEIGHT,
  };
}

function advanceCardPack(pack: CardPackCursor, cardHeight: number): void {
  pack.rowMaxHeight = Math.max(pack.rowMaxHeight, cardHeight);
  pack.col += 1;
  if (pack.col >= CARD_PACK_COLS) {
    pack.col = 0;
    pack.y += pack.rowMaxHeight + CARD_PACK_ROW_GAP;
    pack.rowMaxHeight = 0;
  }
}

/**
 * Build a sticky-style card: rectangle container + bound text that wraps and grows.
 * Fixed-height unbound text truncates mid-word — never do that here.
 */
function cardElements(
  object: CwmObject,
  workspaceId: string,
  proposalId: string | undefined,
  preview: boolean,
  ids?: readonly string[],
  scene: readonly ExcalidrawElement[] = [],
): ExcalidrawElement[] {
  const binding = object.sceneBinding ?? generatedBinding(workspaceId, object.id);
  const finalCardId = binding.primaryElementId ?? binding.elementIds[0]!;
  const finalTextId = binding.elementIds.find((id) => id !== finalCardId) ?? `${finalCardId}-text`;
  const cardId = ids?.[0] ?? finalCardId;
  const textId = ids?.[1] ?? finalTextId;
  const geometry = resolveObjectGeometry(object, workspaceId, scene);
  const width = Math.max(geometry.width, CARD_MIN_WIDTH);
  const title = object.title?.trim() || object.kind;
  const body = object.body.trim();
  const originalText = composeCardText(title, body).slice(0, 600);
  const maxTextWidth = Math.max(40, width - BOUND_TEXT_PADDING * 2);
  const wrappedText = wrapPlainText(originalText, maxTextWidth, CARD_FONT_SIZE);
  const textHeight = measureWrappedTextHeight(wrappedText, CARD_FONT_SIZE, CARD_LINE_HEIGHT);
  const height = Math.max(CARD_MIN_HEIGHT, textHeight + BOUND_TEXT_PADDING * 2);
  const common = {
    objectId: object.id,
    proposalId,
    preview,
    previewText: originalText,
  };
  const card = {
    ...elementBase(cardId, "rectangle", { x: geometry.x, y: geometry.y, width, height }, {
      ...common,
      role: "card",
      finalElementId: finalCardId,
    }),
    strokeColor: preview ? "#7c5cff" : "#5f4b32",
    backgroundColor: object.kind === "decision" ? "#ffe4d7" : "#fff7e8",
    // Excalidraw sticky convention: container owns the bound text child.
    boundElements: [{ id: textId, type: "text" as const }],
  };
  const textElement = {
    ...elementBase(
      textId,
      "text",
      {
        x: geometry.x + BOUND_TEXT_PADDING,
        y: geometry.y + BOUND_TEXT_PADDING,
        width: maxTextWidth,
        height: textHeight,
      },
      { ...common, role: "text", finalElementId: finalTextId },
    ),
    strokeColor: "#30281f",
    backgroundColor: "transparent",
    strokeWidth: 1,
    roundness: null,
    text: wrappedText,
    originalText,
    fontSize: CARD_FONT_SIZE,
    fontFamily: CARD_FONT_FAMILY,
    textAlign: "left",
    verticalAlign: "top",
    containerId: cardId,
    autoResize: true,
    lineHeight: CARD_LINE_HEIGHT,
  };
  return [card, textElement] as unknown as ExcalidrawElement[];
}

function transientIds(proposal: CwmProposal, entityId: string, roles: readonly string[]): string[] {
  return roles.map((role) => `cwm-preview-${stableHash(`${proposal.id}:${entityId}:${role}`)}`);
}

function regionPreview(region: CwmRegion, proposal: CwmProposal): ExcalidrawElement {
  const id = transientIds(proposal, region.id, ["region"])[0]!;
  return {
    ...elementBase(id, "rectangle", region.bounds, {
      regionId: region.id,
      proposalId: proposal.id,
      role: "region",
      preview: true,
      previewText: region.title,
    }),
    strokeColor: "#0b7a75",
    backgroundColor: "transparent",
    strokeWidth: 3,
  } as unknown as ExcalidrawElement;
}

function removalPreview(
  object: CwmObject,
  proposal: CwmProposal,
  scene: readonly ExcalidrawElement[],
): ExcalidrawElement | null {
  const bound = scene.filter((element) => object.sceneBinding?.elementIds.includes(element.id));
  if (!bound.length) return null;
  const x = Math.min(...bound.map((element) => element.x));
  const y = Math.min(...bound.map((element) => element.y));
  const maxX = Math.max(...bound.map((element) => element.x + element.width));
  const maxY = Math.max(...bound.map((element) => element.y + element.height));
  const id = transientIds(proposal, object.id, ["removal"])[0]!;
  return {
    ...elementBase(id, "rectangle", { x, y, width: maxX - x, height: maxY - y }, {
      objectId: object.id,
      proposalId: proposal.id,
      role: "removal",
      preview: true,
      previewText: `Remove ${object.title || object.kind}`,
    }),
    strokeColor: "#c1372a",
    backgroundColor: "#ffd9d2",
    fillStyle: "hachure",
  } as unknown as ExcalidrawElement;
}

export function materializeProposalPreview(
  proposal: CwmProposal,
  scene: readonly ExcalidrawElement[],
  workspace: CwmWorkspace,
): readonly ExcalidrawElement[] {
  const occupied = new Set(scene.map((element) => element.id));
  const previews: ExcalidrawElement[] = [];
  const pack = createCardPackCursor();
  for (const operation of proposal.operations) {
    if (operation.type === "UPSERT_OBJECT") {
      const binding = operation.object.sceneBinding ?? generatedBinding(workspace.id, operation.object.id);
      // New objects can use their final IDs as ghosts. Updates use transient IDs beside the original.
      const conflicts = binding.elementIds.some((id) => occupied.has(id));
      const ids = conflicts
        ? transientIds(proposal, operation.object.id, ["card", "text"])
        : binding.elementIds;
      const objectForCard =
        operation.object.geometry || conflicts
          ? operation.object
          : { ...operation.object, geometry: nextPackedGeometry(pack) };
      const cards = cardElements(objectForCard, workspace.id, proposal.id, true, ids, scene);
      if (!operation.object.geometry && !conflicts) {
        advanceCardPack(pack, cards[0]?.height ?? CARD_MIN_HEIGHT);
      }
      previews.push(...cards);
      cards.forEach((element) => occupied.add(element.id));
    } else if (operation.type === "REMOVE_OBJECT") {
      const existing = workspace.objects[operation.objectId];
      const preview = existing && removalPreview(existing, proposal, scene);
      if (preview) previews.push(preview);
    } else if (operation.type === "UPSERT_REGION") {
      previews.push(regionPreview(operation.region, proposal));
    }
  }
  return previews;
}

export function removeCwmPreviews(
  scene: readonly ExcalidrawElement[],
  proposalId?: string,
): readonly ExcalidrawElement[] {
  return scene.filter((element) => {
    const cwm = metadata(element);
    return !cwm?.preview || (proposalId !== undefined && cwm.proposalId !== proposalId);
  });
}

export function withPendingProposalPreviews(
  scene: readonly ExcalidrawElement[],
  workspace: CwmWorkspace,
): readonly ExcalidrawElement[] {
  const committed = removeCwmPreviews(scene);
  const pending = Object.values(workspace.proposals).filter((proposal) => proposal.status === "PENDING");
  return pending.reduce<readonly ExcalidrawElement[]>(
    (current, proposal) => [...current, ...materializeProposalPreview(proposal, current, workspace)],
    committed,
  );
}

/** Apply confirmed semantic meaning to scene elements; this function accepts no raw scene commands. */
export function materializeConfirmedOperations(
  scene: readonly ExcalidrawElement[],
  operations: readonly CwmSemanticOperation[],
  workspaceBefore: CwmWorkspace,
  rationale = "",
): readonly ExcalidrawElement[] {
  let next = [...removeCwmPreviews(scene)];
  // Action notes only for updates/removals of existing canvas targets — not brand-new cards.
  const annotateObjectIds: string[] = [];
  const pack = createCardPackCursor();

  for (const operation of operations) {
    if (operation.type === "REMOVE_OBJECT") {
      const ids = new Set(workspaceBefore.objects[operation.objectId]?.sceneBinding?.elementIds ?? []);
      next = next.filter((element) => !ids.has(element.id));
      annotateObjectIds.push(operation.objectId);
      continue;
    }
    if (operation.type !== "UPSERT_OBJECT") continue;

    const binding = operation.object.sceneBinding ?? generatedBinding(workspaceBefore.id, operation.object.id);
    const bound = next.filter((element) => binding.elementIds.includes(element.id));
    const generated = bound.some((element) => metadata(element)?.objectId === operation.object.id);
    // Never rewrite the user's original sticky text. Session feedback is the action note only.
    if (bound.length > 0 && !generated) {
      annotateObjectIds.push(operation.object.id);
      continue;
    }
    const anchored = resolveObjectAnchorElements(operation.object, next);
    const anchoredIsOrdinary =
      anchored.length > 0 && !anchored.some((element) => metadata(element)?.objectId);
    if (anchoredIsOrdinary) {
      annotateObjectIds.push(operation.object.id);
      continue;
    }
    // Existing CWM-generated cards stay put. Only annotate when the semantic object changed
    // (status/body updates) — identical re-UPSERTs must not spam ↳ notes under every card.
    if (bound.length > 0 && generated) {
      const before = workspaceBefore.objects[operation.object.id];
      const changed =
        before &&
        (before.body !== operation.object.body ||
          before.title !== operation.object.title ||
          before.kind !== operation.object.kind ||
          before.phase !== operation.object.phase);
      if (changed) annotateObjectIds.push(operation.object.id);
      continue;
    }

    // Brand-new cards: pack into a readable 2-column layout unless geometry was explicit.
    const objectForCard = operation.object.geometry
      ? operation.object
      : { ...operation.object, geometry: nextPackedGeometry(pack) };
    const replacements = cardElements(objectForCard, workspaceBefore.id, undefined, false, undefined, next);
    if (!operation.object.geometry) {
      advanceCardPack(pack, replacements[0]?.height ?? CARD_MIN_HEIGHT);
    }
    const replacementIds = new Set(binding.elementIds);
    const firstIndex = next.findIndex((element) => replacementIds.has(element.id));
    next = next.filter((element) => !replacementIds.has(element.id));
    next.splice(firstIndex < 0 ? next.length : firstIndex, 0, ...replacements);
  }

  return appendActionAnnotations(next, operations, workspaceBefore, rationale, annotateObjectIds);
}

function actionNoteLabel(operation: CwmSemanticOperation, rationale: string): string {
  if (operation.type === "REMOVE_OBJECT") {
    return `↳ removed`;
  }
  if (operation.type !== "UPSERT_OBJECT") return `↳ ${rationale.slice(0, 72) || "updated"}`;
  const title = operation.object.title?.trim() || "";
  const bodyLine = operation.object.body.trim().split("\n")[0] || "";
  const detail = (rationale.trim() || title || bodyLine || operation.object.kind).slice(0, 72);
  return `↳ ${detail}`;
}

/**
 * Small plain Excalidraw text under existing targets that were just acted on.
 * Brand-new stickies do not get a note — the card itself is the content.
 */
export function appendActionAnnotations(
  scene: readonly ExcalidrawElement[],
  operations: readonly CwmSemanticOperation[],
  workspace: CwmWorkspace,
  rationale: string,
  /** When provided (including `[]`), only these object ids get notes. When omitted, derive from ops. */
  annotateObjectIds?: readonly string[],
): readonly ExcalidrawElement[] {
  const objectIds = new Set(
    annotateObjectIds !== undefined
      ? annotateObjectIds
      : operations.flatMap((operation) => {
          if (operation.type === "UPSERT_OBJECT") return [operation.object.id];
          if (operation.type === "REMOVE_OBJECT") return [operation.objectId];
          return [];
        }),
  );
  if (!objectIds.size) return scene;

  let next = scene.filter((element) => {
    const data = metadata(element);
    return !(data?.role === "action_note" && data.objectId && objectIds.has(data.objectId));
  });

  for (const operation of operations) {
    let objectId = "";
    let object: CwmObject | null = null;
    if (operation.type === "UPSERT_OBJECT") {
      objectId = operation.object.id;
      object = operation.object;
    } else if (operation.type === "REMOVE_OBJECT") {
      objectId = operation.objectId;
      object = workspace.objects[objectId] ?? null;
    } else {
      continue;
    }

    const anchors = object
      ? resolveObjectAnchorElements(object, next)
      : next.filter((element) => metadata(element)?.objectId === objectId && !element.isDeleted);
    const fallback =
      object?.sceneBinding?.elementIds
        .map((id) => next.find((element) => element.id === id && !element.isDeleted))
        .filter((element): element is ExcalidrawElement => Boolean(element)) ?? [];
    const targets = anchors.length ? anchors : fallback;
    if (!targets.length) continue;

    const minX = Math.min(...targets.map((element) => element.x));
    const maxY = Math.max(...targets.map((element) => element.y + element.height));
    const label = actionNoteLabel(operation, rationale);
    const noteId = `cwm-action-${stableHash(`${workspace.id}:${objectId}:action_note`)}`;
    const fontSize = 14;
    const width = Math.min(360, Math.max(120, label.length * 7));
    const height = Math.ceil(fontSize * 1.35);
    const note = {
      ...elementBase(
        noteId,
        "text",
        { x: minX, y: maxY + 10, width, height },
        {
          objectId,
          role: "action_note",
          preview: false,
          previewText: label,
        },
      ),
      strokeColor: "#6b5f52",
      backgroundColor: "transparent",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      roundness: null,
      text: label,
      originalText: label,
      fontSize,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
      locked: false,
    };
    next = [...next.filter((element) => element.id !== noteId), note as unknown as ExcalidrawElement];
  }
  return next;
}

export function summarizeCwmOperation(operation: CwmSemanticOperation): string {
  switch (operation.type) {
    case "UPSERT_OBJECT":
      return `${operation.object.kind}: ${operation.object.title || operation.object.body || operation.object.id}`;
    case "REMOVE_OBJECT":
      return `Remove object ${operation.objectId}`;
    case "UPSERT_RELATION":
      return `${operation.relation.kind} relation`;
    case "REMOVE_RELATION":
      return `Remove relation ${operation.relationId}`;
    case "UPSERT_REGION":
      return `Region: ${operation.region.title}`;
    case "REMOVE_REGION":
      return `Remove region ${operation.regionId}`;
    case "SET_MODE":
      return `Mode → ${operation.mode}`;
    case "SET_FOCUS":
      return operation.focus ? "Focus selection" : "Clear focus";
    case "SET_OPENING_BRIEF":
      return operation.openingBrief ? "Update opening brief" : "Clear opening brief";
    case "SET_SCENE_BINDING":
      return `Bind object ${operation.objectId}`;
  }
}
