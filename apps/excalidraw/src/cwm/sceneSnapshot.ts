import type { CwmProposal, CwmSemanticOperation, CwmWorkspace } from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

export const CWM_SNAPSHOT_MAX_ELEMENTS = 40;
export const CWM_SNAPSHOT_MAX_ELEMENT_TEXT = 120;
export const CWM_SNAPSHOT_MAX_BYTES = 8 * 1024;

export interface CwmScenePreviewItem {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly selected: boolean;
  readonly cwmObjectId?: string;
}

export interface CwmSceneSnapshot {
  readonly activeView: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly zoom: number;
  };
  readonly loadedFile: string | null;
  readonly selection: readonly string[];
  readonly focusedRegions: readonly string[];
  readonly openingBrief: {
    readonly summary: string;
    readonly sourceObjectIds: readonly string[];
  } | null;
  readonly pendingProposal: {
    readonly id: string;
    readonly actionClass: string;
    readonly rationale: string;
    readonly operations: readonly string[];
  } | null;
  readonly scenePreview: readonly CwmScenePreviewItem[];
}

export interface CreateSceneSnapshotInput {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Pick<
    AppState,
    "scrollX" | "scrollY" | "width" | "height" | "zoom" | "selectedElementIds"
  >;
  readonly loadedFile: string | null;
  readonly workspace: CwmWorkspace | null;
  readonly pendingProposal?: CwmProposal | null;
}

const bounded = (value: string, max = CWM_SNAPSHOT_MAX_ELEMENT_TEXT): string =>
  value.replace(/\s+/g, " ").trim().slice(0, max);

const finite = (value: number): number => (Number.isFinite(value) ? Math.round(value * 100) / 100 : 0);

function operationSummary(operation: CwmSemanticOperation): string {
  switch (operation.type) {
    case "UPSERT_OBJECT":
      return `Upsert ${operation.object.kind} ${operation.object.title || operation.object.body}`;
    case "REMOVE_OBJECT":
      return `Remove object ${operation.objectId}`;
    case "UPSERT_RELATION":
      return `Upsert ${operation.relation.kind} relation ${operation.relation.id}`;
    case "REMOVE_RELATION":
      return `Remove relation ${operation.relationId}`;
    case "UPSERT_REGION":
      return `Upsert region ${operation.region.title}`;
    case "REMOVE_REGION":
      return `Remove region ${operation.regionId}`;
    case "SET_MODE":
      return `Set mode ${operation.mode}`;
    case "SET_FOCUS":
      return operation.focus ? "Focus workspace entities" : "Clear workspace focus";
    case "SET_OPENING_BRIEF":
      return operation.openingBrief ? "Update opening brief" : "Clear opening brief";
    case "SET_SCENE_BINDING":
      return `Update scene binding for ${operation.objectId}`;
  }
}

function elementText(element: ExcalidrawElement): string {
  if (element.type === "text") return bounded(element.originalText || element.text);
  if (typeof element.link === "string" && element.link) return bounded(element.link);
  const customData = element.customData as
    | { cwm?: { objectId?: unknown; previewText?: unknown } }
    | undefined;
  if (typeof customData?.cwm?.previewText === "string") {
    return bounded(customData.cwm.previewText);
  }
  return "";
}

function isVisible(
  element: ExcalidrawElement,
  view: CwmSceneSnapshot["activeView"],
): boolean {
  return (
    element.x + element.width >= view.x &&
    element.y + element.height >= view.y &&
    element.x <= view.x + view.width &&
    element.y <= view.y + view.height
  );
}

function objectIdForElement(element: ExcalidrawElement, workspace: CwmWorkspace | null): string | undefined {
  const customData = element.customData as { cwm?: { objectId?: unknown } } | undefined;
  if (typeof customData?.cwm?.objectId === "string") return bounded(customData.cwm.objectId, 80);
  if (!workspace) return undefined;
  return Object.values(workspace.objects).find((object) =>
    object.sceneBinding?.elementIds.includes(element.id),
  )?.id;
}

export function snapshotSerializedBytes(snapshot: CwmSceneSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

/**
 * Produce the small, deterministic context envelope sent to an agent. Selection and focused
 * semantic objects win over viewport-visible and off-screen elements.
 */
export function createBoundedSceneSnapshot(input: CreateSceneSnapshotInput): CwmSceneSnapshot {
  const zoom = Math.max(Number(input.appState.zoom?.value) || 1, 0.01);
  const activeView = {
    x: finite(-input.appState.scrollX),
    y: finite(-input.appState.scrollY),
    width: finite(input.appState.width / zoom),
    height: finite(input.appState.height / zoom),
    zoom: finite(zoom),
  };
  const selected = new Set(Object.keys(input.appState.selectedElementIds));
  const focusedRegions = (input.workspace?.focus?.regionIds ?? []).slice(0, 12);
  const focusedObjects = new Set(input.workspace?.focus?.objectIds ?? []);
  for (const regionId of focusedRegions) {
    const region = input.workspace?.regions[regionId];
    region?.objectIds.forEach((id) => focusedObjects.add(id));
  }

  const ranked = input.elements
    .filter((element) => !element.isDeleted)
    .map((element, index) => {
      const objectId = objectIdForElement(element, input.workspace);
      const priority =
        (selected.has(element.id) ? 1_000 : 0) +
        (objectId && focusedObjects.has(objectId) ? 500 : 0) +
        (isVisible(element, activeView) ? 100 : 0) -
        index / Math.max(input.elements.length, 1);
      return { element, objectId, priority };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, CWM_SNAPSHOT_MAX_ELEMENTS);

  const pending =
    input.pendingProposal ??
    Object.values(input.workspace?.proposals ?? {}).find((proposal) => proposal.status === "PENDING") ??
    null;
  const snapshot: CwmSceneSnapshot = {
    activeView,
    loadedFile: input.loadedFile === null ? null : bounded(input.loadedFile, 240),
    selection: [...selected].slice(0, 20).map((id) => bounded(id, 80)),
    focusedRegions: focusedRegions.map((id) => bounded(id, 80)),
    openingBrief: input.workspace?.openingBrief
      ? {
          summary: bounded(input.workspace.openingBrief.summary, 480),
          sourceObjectIds: input.workspace.openingBrief.sourceObjectIds
            .slice(0, 16)
            .map((id) => bounded(id, 80)),
        }
      : null,
    pendingProposal: pending
      ? {
          id: bounded(pending.id, 80),
          actionClass: pending.actionClass,
          rationale: bounded(pending.rationale ?? "", 320),
          operations: pending.operations.slice(0, 16).map((operation) => bounded(operationSummary(operation))),
        }
      : null,
    scenePreview: ranked.map(({ element, objectId }) => ({
      id: bounded(element.id, 80),
      type: bounded(element.type, 30),
      x: finite(element.x),
      y: finite(element.y),
      width: finite(element.width),
      height: finite(element.height),
      text: elementText(element),
      selected: selected.has(element.id),
      ...(objectId ? { cwmObjectId: bounded(objectId, 80) } : {}),
    })),
  };

  // Defensive final fitting keeps the contract true even with pathological identifiers.
  while (snapshotSerializedBytes(snapshot) > CWM_SNAPSHOT_MAX_BYTES && snapshot.scenePreview.length > 0) {
    (snapshot.scenePreview as CwmScenePreviewItem[]).pop();
  }
  while (
    snapshotSerializedBytes(snapshot) > CWM_SNAPSHOT_MAX_BYTES &&
    (snapshot.pendingProposal?.operations.length ?? 0) > 0
  ) {
    (snapshot.pendingProposal!.operations as string[]).pop();
  }
  while (snapshotSerializedBytes(snapshot) > CWM_SNAPSHOT_MAX_BYTES && snapshot.selection.length > 0) {
    (snapshot.selection as string[]).pop();
  }
  while (snapshotSerializedBytes(snapshot) > CWM_SNAPSHOT_MAX_BYTES && snapshot.focusedRegions.length > 0) {
    (snapshot.focusedRegions as string[]).pop();
  }
  if (snapshotSerializedBytes(snapshot) > CWM_SNAPSHOT_MAX_BYTES) {
    throw new Error("Could not fit Curatorial Whiteboard scene snapshot within 8KB");
  }
  return snapshot;
}
