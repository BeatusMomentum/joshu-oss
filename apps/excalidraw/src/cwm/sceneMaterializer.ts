import type {
  CwmObject,
  CwmProposal,
  CwmRegion,
  CwmSceneBinding,
  CwmSemanticOperation,
  CwmWorkspace,
} from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";

interface CwmElementData {
  readonly objectId?: string;
  readonly regionId?: string;
  readonly proposalId?: string;
  readonly role: "card" | "text" | "region" | "removal";
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

function defaultGeometry(workspaceId: string, objectId: string): CwmObject["geometry"] {
  const hash = Number.parseInt(stableHash(`${workspaceId}:${objectId}`).slice(0, 7), 36);
  return {
    x: 80 + (hash % 5) * 260,
    y: 80 + (Math.floor(hash / 5) % 5) * 180,
    width: 230,
    height: 130,
  };
}

function cardElements(
  object: CwmObject,
  workspaceId: string,
  proposalId: string | undefined,
  preview: boolean,
  ids?: readonly string[],
): ExcalidrawElement[] {
  const binding = object.sceneBinding ?? generatedBinding(workspaceId, object.id);
  const finalCardId = binding.primaryElementId ?? binding.elementIds[0]!;
  const finalTextId = binding.elementIds.find((id) => id !== finalCardId) ?? `${finalCardId}-text`;
  const cardId = ids?.[0] ?? finalCardId;
  const textId = ids?.[1] ?? finalTextId;
  const geometry = object.geometry ?? defaultGeometry(workspaceId, object.id);
  const width = Math.max(geometry.width, 160);
  const height = Math.max(geometry.height, 90);
  const title = object.title?.trim() || object.kind;
  const body = object.body.trim();
  const text = `${title}\n${body}`.slice(0, 600);
  const common = {
    objectId: object.id,
    proposalId,
    preview,
    previewText: text,
  };
  const card = {
    ...elementBase(cardId, "rectangle", { ...geometry, width, height }, {
      ...common,
      role: "card",
      finalElementId: finalCardId,
    }),
    strokeColor: preview ? "#7c5cff" : "#5f4b32",
    backgroundColor: object.layer === "COMMITMENT" ? "#ffe4d7" : "#fff7e8",
  };
  const fontSize = 18;
  const textElement = {
    ...elementBase(
      textId,
      "text",
      {
        x: geometry.x + 14,
        y: geometry.y + 14,
        width: Math.max(40, width - 28),
        height: Math.max(24, height - 28),
      },
      { ...common, role: "text", finalElementId: finalTextId },
    ),
    strokeColor: "#30281f",
    backgroundColor: "transparent",
    strokeWidth: 1,
    roundness: null,
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: false,
    lineHeight: 1.25,
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
  for (const operation of proposal.operations) {
    if (operation.type === "UPSERT_OBJECT") {
      const binding = operation.object.sceneBinding ?? generatedBinding(workspace.id, operation.object.id);
      // New objects can use their final IDs as ghosts. Updates use transient IDs beside the original.
      const conflicts = binding.elementIds.some((id) => occupied.has(id));
      const ids = conflicts
        ? transientIds(proposal, operation.object.id, ["card", "text"])
        : binding.elementIds;
      const cards = cardElements(operation.object, workspace.id, proposal.id, true, ids);
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
): readonly ExcalidrawElement[] {
  let next = [...removeCwmPreviews(scene)];
  for (const operation of operations) {
    if (operation.type === "REMOVE_OBJECT") {
      const ids = new Set(workspaceBefore.objects[operation.objectId]?.sceneBinding?.elementIds ?? []);
      next = next.filter((element) => !ids.has(element.id));
      continue;
    }
    if (operation.type !== "UPSERT_OBJECT") continue;

    const binding = operation.object.sceneBinding ?? generatedBinding(workspaceBefore.id, operation.object.id);
    const bound = next.filter((element) => binding.elementIds.includes(element.id));
    const generated = bound.some((element) => metadata(element)?.objectId === operation.object.id);
    // A promoted ordinary element keeps its exact visual representation; meaning stays in the sidecar.
    if (bound.length > 0 && !generated) continue;

    const replacements = cardElements(operation.object, workspaceBefore.id, undefined, false);
    const replacementIds = new Set(binding.elementIds);
    const firstIndex = next.findIndex((element) => replacementIds.has(element.id));
    next = next.filter((element) => !replacementIds.has(element.id));
    next.splice(firstIndex < 0 ? next.length : firstIndex, 0, ...replacements);
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
