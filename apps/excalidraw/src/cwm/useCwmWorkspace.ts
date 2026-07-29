import {
  renderCwmSessionMarkdown,
  type CwmActor,
  type CwmEvent,
  type CwmFocus,
  type CwmObject,
  type CwmObjectKind,
  type CwmPhase,
  type CwmProposal,
  type CwmRegion,
  type CwmSemanticOperation,
  type CwmWorkspace,
} from "@joshu/whiteboard-cwm";
import { createJoshuPlatformData } from "@joshu/platform-data";
import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CwmApiError, cwmApiClient } from "./apiClient";
import { boundedDeicticContext, type DeicticContext } from "./deicticResolver";
import {
  materializeConfirmedOperations,
  normalizeSemanticOperations,
  removeCwmPreviews,
} from "./sceneMaterializer";
import {
  createBoundedSceneSnapshot,
  type CwmAnchoredSelection,
  type CwmSceneSnapshot,
  type CwmSelectedItem,
  type CreateSceneSnapshotInput,
} from "./sceneSnapshot";

/** Keep last canvas selection while the user types in chat (Excalidraw clears live selection). */
const ANCHORED_SELECTION_TTL_MS = 5 * 60 * 1000;

function captureLiveSelectionAnchor(
  elements: readonly ExcalidrawElement[],
  appState: CreateSceneSnapshotInput["appState"],
  workspace: CwmWorkspace | null,
): (CwmAnchoredSelection & { capturedAt: number }) | null {
  const snapshot = createBoundedSceneSnapshot({
    elements,
    appState,
    loadedFile: null,
    workspace,
  });
  if (snapshot.selectionSource !== "live" || snapshot.selectedItems.length === 0) {
    return null;
  }
  return {
    selection: snapshot.selection,
    selectedItems: snapshot.selectedItems as readonly CwmSelectedItem[],
    capturedAt: Date.now(),
  };
}
import {
  MAX_RECALL_CARDS,
  normalizeRecallPayload,
  selectDiverseRecallCards,
} from "./retrieval";

export type CwmUiStatus =
  | { readonly kind: "ineligible"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "ready"; readonly message: string }
  | { readonly kind: "offline"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export interface PromoteSelectionInput {
  readonly kind?: CwmObjectKind;
  readonly phase?: CwmPhase;
}

export interface ProposeOperationsOptions {
  readonly actor?: CwmActor;
  readonly bindingsByObjectId?: Readonly<Record<string, readonly string[]>>;
}

export function reliableCwmBoardPath(path: string | null): string | null {
  if (!path) return null;
  const clean = path.replace(/\\/g, "/");
  if (
    clean.startsWith("/") ||
    !clean.endsWith(".excalidraw") ||
    clean.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Curatorial Whiteboard request failed";
}

function selectedSceneElements(api: ExcalidrawImperativeAPI): ExcalidrawElement[] {
  const selected = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter((element) => selected[element.id] && !element.isDeleted);
}

function textForElement(element: ExcalidrawElement): string {
  if (element.type === "text") return element.originalText || element.text;
  return element.link || `${element.type} element`;
}

function sceneEnvelope(
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
): unknown {
  return JSON.parse(
    serializeAsJSON(elements, api.getAppState(), api.getFiles(), "local"),
  ) as unknown;
}

function sceneFingerprint(elements: readonly ExcalidrawElement[]): string {
  let versionSum = 0;
  let textHash = 0;
  for (const element of elements) {
    if (element.isDeleted) continue;
    versionSum += Number(element.version) || 0;
    const text =
      element.type === "text"
        ? String((element as { originalText?: string; text?: string }).originalText || (element as { text?: string }).text || "")
        : "";
    for (let index = 0; index < text.length; index += 1) {
      textHash = (textHash + text.charCodeAt(index) * (index + 1)) % 1_000_000_007;
    }
  }
  return `${elements.length}:${versionSum}:${textHash}`;
}

const AUTOSAVE_DEBOUNCE_MS = 1_200;

export function useCwmWorkspace(
  api: ExcalidrawImperativeAPI | null,
  boardPath: string | null,
  loadedFile: string | null,
  joshuApiBase: string,
) {
  const eligiblePath = reliableCwmBoardPath(boardPath);
  const workspaceRef = useRef<CwmWorkspace | null>(null);
  const eventsRef = useRef<readonly CwmEvent[]>([]);
  const deicticContextRef = useRef<DeicticContext | null>(null);
  const focusRef = useRef<CwmFocus | null>(null);
  const anchoredSelectionRef = useRef<(CwmAnchoredSelection & { capturedAt: number }) | null>(
    null,
  );
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveInFlightRef = useRef(false);
  const lastSavedFingerprintRef = useRef<string>("");
  const [workspace, setWorkspaceState] = useState<CwmWorkspace | null>(null);
  const [events, setEvents] = useState<readonly CwmEvent[]>([]);
  const [focus, setFocusState] = useState<CwmFocus | null>(null);
  const [selectedElements, setSelectedElements] = useState<readonly ExcalidrawElement[]>([]);
  const [status, setStatus] = useState<CwmUiStatus>({
    kind: "ineligible",
    message: "Open a .excalidraw file under joshu's files to enable CWM.",
  });
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [consolidationBusy, setConsolidationBusy] = useState(false);
  const [handoffPath, setHandoffPath] = useState<string | null>(null);
  const platformData = useMemo(
    () => createJoshuPlatformData({ apiBase: joshuApiBase }),
    [joshuApiBase],
  );

  const setWorkspace = useCallback((next: CwmWorkspace | null) => {
    workspaceRef.current = next;
    setWorkspaceState(next);
  }, []);

  const setRecentEvents = useCallback(
    (
      next:
        | readonly CwmEvent[]
        | ((current: readonly CwmEvent[]) => readonly CwmEvent[]),
    ) => {
      const value = typeof next === "function" ? next(eventsRef.current) : next;
      eventsRef.current = value;
      setEvents(value);
    },
    [],
  );

  const setDeicticContext = useCallback((context: DeicticContext | null) => {
    deicticContextRef.current = context ? boundedDeicticContext(context) : null;
  }, []);

  const setEphemeralFocus = useCallback((next: CwmFocus | null) => {
    focusRef.current = next;
    setFocusState(next);
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!eligiblePath) return null;
      const board = await cwmApiClient.getBoard(eligiblePath, signal);
      const afterSequence = Math.max(0, board.workspace.headSequence - 99);
      const tail = await cwmApiClient.getEvents(
        eligiblePath,
        { afterSequence, limit: 100 },
        signal,
      );
      setWorkspace(board.workspace);
      setRecentEvents(tail.events);
      setStatus({
        kind: "ready",
        message: `CWM ready · head ${board.workspace.headSequence} · ${tail.events.length} recent events`,
      });
      return board.workspace;
    },
    [eligiblePath, setRecentEvents, setWorkspace],
  );

  useEffect(() => {
    setWorkspace(null);
    setRecentEvents([]);
    setHandoffPath(null);
    setEphemeralFocus(null);
    anchoredSelectionRef.current = null;
    lastSavedFingerprintRef.current = "";
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (!eligiblePath) {
      setStatus({
        kind: "ineligible",
        message: "CWM inactive — this board is not a reliable joshu files .excalidraw path.",
      });
      return;
    }
    const controller = new AbortController();
    setStatus({ kind: "loading", message: `Loading CWM sidecar for ${eligiblePath}…` });
    void refresh(controller.signal).catch((error) => {
      if (controller.signal.aborted) return;
      setStatus({
        kind: error instanceof CwmApiError && error.status >= 500 ? "offline" : "error",
        message: `CWM unavailable — ${errorMessage(error)}`,
      });
    });
    return () => controller.abort();
  }, [eligiblePath, refresh, setEphemeralFocus, setRecentEvents, setWorkspace]);

  const runAutosave = useCallback(
    async (reason: string) => {
      const current = workspaceRef.current;
      if (!api || !eligiblePath || !current || autosaveInFlightRef.current) return;
      const acceptedElements = removeCwmPreviews(api.getSceneElements());
      const fingerprint = sceneFingerprint(acceptedElements);
      if (fingerprint === lastSavedFingerprintRef.current) return;

      autosaveInFlightRef.current = true;
      try {
        const checkpoint = await cwmApiClient.checkpoint({
          path: eligiblePath,
          headSequence: current.headSequence,
          actor: "HUMAN",
          scene: sceneEnvelope(api, acceptedElements),
          reason: `Autosave · ${reason}`,
        });
        lastSavedFingerprintRef.current = fingerprint;
        setWorkspace(checkpoint.workspace);
        setRecentEvents((value) => [...value, checkpoint.event].slice(-100));
        setStatus({
          kind: "ready",
          message: `Autosaved · head ${checkpoint.workspace.headSequence}`,
        });
      } catch (error) {
        if (error instanceof CwmApiError && error.status === 409) {
          await refresh().catch(() => undefined);
          return;
        }
        // Non-fatal: keep editing; next change will retry.
        console.warn("[cwm] autosave failed", error);
      } finally {
        autosaveInFlightRef.current = false;
      }
    },
    [api, eligiblePath, refresh, setRecentEvents, setWorkspace],
  );

  const scheduleAutosave = useCallback(
    (reason: string, delayMs = AUTOSAVE_DEBOUNCE_MS) => {
      if (!api || !eligiblePath || !workspaceRef.current) return;
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        void runAutosave(reason);
      }, delayMs);
    },
    [api, eligiblePath, runAutosave],
  );

  useEffect(() => {
    if (!api) {
      setSelectedElements([]);
      return;
    }
    const updateSelection = (
      elements?: readonly ExcalidrawElement[],
      appState?: ReturnType<ExcalidrawImperativeAPI["getAppState"]>,
    ) => {
      const scene = elements ?? api.getSceneElements();
      const state = appState ?? api.getAppState();
      setSelectedElements(scene.filter((element) => state.selectedElementIds[element.id] && !element.isDeleted));
      // Capture from the onChange payload — do not re-query after chat focus may have cleared it.
      const nextAnchor = captureLiveSelectionAnchor(scene, state, workspaceRef.current);
      if (nextAnchor) {
        anchoredSelectionRef.current = nextAnchor;
      }
      // Mechanical sidecar autosave — not an agent action.
      if (workspaceRef.current && eligiblePath) {
        const fingerprint = sceneFingerprint(removeCwmPreviews(scene));
        if (fingerprint !== lastSavedFingerprintRef.current) {
          scheduleAutosave("scene-change");
        }
      }
    };
    updateSelection();
    // Seed fingerprint after load so the first paint does not immediately rewrite the file.
    if (eligiblePath && lastSavedFingerprintRef.current === "") {
      lastSavedFingerprintRef.current = sceneFingerprint(removeCwmPreviews(api.getSceneElements()));
    }
    return api.onChange((elements, appState) => updateSelection(elements, appState));
  }, [api, eligiblePath, scheduleAutosave]);

  useEffect(() => {
    const flush = () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      void runAutosave("pagehide");
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [runAutosave]);

  useEffect(() => {
    if (!api || !workspace) return;
    // Strip any leftover proposal ghosts from earlier confirmation UX.
    const current = api.getSceneElements();
    const cleaned = removeCwmPreviews(current);
    if (cleaned.length !== current.length) {
      api.updateScene({ elements: cleaned });
    }
  }, [api, workspace]);

  const pendingProposals = useMemo(
    () =>
      Object.values(workspace?.proposals ?? {})
        .filter((proposal) => proposal.status === "PENDING")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [workspace],
  );

  const selectedObjects = useMemo(() => {
    if (!workspace) return [];
    const selectedIds = new Set(selectedElements.map((element) => element.id));
    return Object.values(workspace.objects).filter((object) =>
      object.sceneBinding?.elementIds.some((id) => selectedIds.has(id)),
    );
  }, [selectedElements, workspace]);

  const proposeOperations = useCallback(
    async (
      operations: readonly CwmSemanticOperation[],
      rationale: string,
      options: ProposeOperationsOptions = {},
    ) => {
      const current = workspaceRef.current;
      if (!eligiblePath || !current) throw new Error("CWM workspace is not ready");
      setMutationBusy(true);
      try {
        const normalized = normalizeSemanticOperations(operations, current, {
          bindingsByObjectId: options.bindingsByObjectId,
        });
        const result = await cwmApiClient.propose({
          path: eligiblePath,
          headSequence: current.headSequence,
          actor: options.actor ?? "HUMAN",
          operations: normalized,
          rationale,
        });
        setWorkspace(result.workspace);
        setRecentEvents((value) => [...value, result.event].slice(-100));
        // Session whiteboard: apply immediately and leave a small action note under targets.
        if (api) {
          const nextElements = materializeConfirmedOperations(
            api.getSceneElements(),
            normalized,
            current,
            rationale,
          );
          api.updateScene({ elements: nextElements });
          scheduleAutosave("cwm-apply", 250);
        }
        setStatus({
          kind: "ready",
          message: `CWM change applied · head ${result.workspace.headSequence}`,
        });
        return result;
      } catch (error) {
        if (error instanceof CwmApiError && error.status === 409) await refresh();
        setStatus({ kind: "error", message: `CWM proposal failed — ${errorMessage(error)}` });
        throw error;
      } finally {
        setMutationBusy(false);
      }
    },
    [api, eligiblePath, refresh, scheduleAutosave, setRecentEvents, setWorkspace],
  );

  const recallToBoard = useCallback(
    async (query: string, requestedLimit = MAX_RECALL_CARDS) => {
      const trimmedQuery = query.trim().slice(0, 500);
      if (!trimmedQuery) throw new Error("Recall query is required");
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(MAX_RECALL_CARDS, Math.trunc(requestedLimit)))
        : MAX_RECALL_CARDS;
      const [files, memory] = await Promise.allSettled([
        platformData.files.query({ q: trimmedQuery, limit }),
        platformData.memory.recall({ q: trimmedQuery, limit }),
      ]);
      if (files.status === "rejected" && memory.status === "rejected") {
        throw new Error("File Brain and Hindsight recall are both unavailable");
      }
      const cards = selectDiverseRecallCards(
        files.status === "fulfilled"
          ? normalizeRecallPayload(files.value, "file", trimmedQuery)
          : [],
        memory.status === "fulfilled"
          ? normalizeRecallPayload(memory.value, "memory", trimmedQuery)
          : [],
        limit,
      );
      if (!cards.length) throw new Error("Recall returned no usable source evidence");

      const now = new Date().toISOString();
      const timestampId = now.replace(/\D/g, "").slice(0, 17);
      const operations = cards.map<CwmSemanticOperation>((card, index) => {
        const objectId = `recall-${timestampId}-${card.source}-${index + 1}`;
        return {
          type: "UPSERT_OBJECT",
          object: {
            id: objectId,
            kind: "note",
            phase: "accepted",
            title: card.title,
            body: card.text,
            createdBy: "AI",
            createdAt: now,
            updatedAt: now,
            provenance: [
              {
                id: `provenance-${objectId}`,
                kind: card.source === "file" ? "FILE" : "MEMORY",
                sourceId: card.sourceId,
                sourceUri: card.sourceUri,
                locator: card.locator,
                excerpt: card.text,
                capturedBy: "AI",
                capturedAt: now,
              },
            ],
            metadata: { retrievalSource: card.source, retrievalQuery: trimmedQuery },
          },
        };
      });
      await proposeOperations(
        operations,
        `Recall "${trimmedQuery}" from ${new Set(cards.map((card) => card.source)).size} source lane(s)`,
        { actor: "AI" },
      );
      return cards.length;
    },
    [platformData, proposeOperations],
  );

  const promoteSelection = useCallback(
    async (input: PromoteSelectionInput = {}) => {
      const current = workspaceRef.current;
      if (!current || selectedElements.length === 0) return;
      const now = new Date().toISOString();
      const ordinary = selectedElements.filter(
        (element) =>
          !Object.values(current.objects).some((object) =>
            object.sceneBinding?.elementIds.includes(element.id),
          ) &&
          !(element.customData as { cwm?: { preview?: boolean } } | undefined)?.cwm?.preview,
      );
      if (!ordinary.length) throw new Error("Select one or more ordinary canvas elements to type");

      const bindings: Record<string, readonly string[]> = {};
      const kind = input.kind ?? "note";
      const phase = input.phase ?? (kind === "decision" ? "pending" : "accepted");
      const operations = ordinary.map<CwmSemanticOperation>((element) => {
        const objectId = `object-${element.id}`;
        bindings[objectId] = [element.id];
        const body = textForElement(element).slice(0, 20_000);
        const object: CwmObject = {
          id: objectId,
          kind,
          phase,
          title: body.slice(0, 120),
          body,
          createdBy: "HUMAN",
          createdAt: now,
          updatedAt: now,
          provenance: [
            {
              id: `provenance-${element.id}`,
              kind: "HUMAN_INPUT",
              sourceId: element.id,
              excerpt: body.slice(0, 240),
              capturedBy: "HUMAN",
              capturedAt: now,
              confidence: 1,
            },
          ],
          geometry: {
            x: element.x,
            y: element.y,
            width: Math.max(0, element.width),
            height: Math.max(0, element.height),
            rotation: element.angle,
          },
        };
        return { type: "UPSERT_OBJECT", object };
      });
      await proposeOperations(
        operations,
        `Human promoted ${ordinary.length} selected canvas element${ordinary.length === 1 ? "" : "s"}`,
        { bindingsByObjectId: bindings },
      );
    },
    [proposeOperations, selectedElements],
  );

  const createRegion = useCallback(
    async (title: string) => {
      const current = workspaceRef.current;
      if (!current || !selectedElements.length || !title.trim()) return;
      const x = Math.min(...selectedElements.map((element) => element.x));
      const y = Math.min(...selectedElements.map((element) => element.y));
      const maxX = Math.max(...selectedElements.map((element) => element.x + element.width));
      const maxY = Math.max(...selectedElements.map((element) => element.y + element.height));
      const selectedIds = new Set(selectedElements.map((element) => element.id));
      const objectIds = Object.values(current.objects)
        .filter((object) => object.sceneBinding?.elementIds.some((id) => selectedIds.has(id)))
        .map((object) => object.id);
      const now = new Date().toISOString();
      const region: CwmRegion = {
        id: `region-${now.replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.trim(),
        phase: "accepted",
        bounds: { x, y, width: Math.max(0, maxX - x), height: Math.max(0, maxY - y) },
        objectIds,
        createdBy: "HUMAN",
        createdAt: now,
      };
      await proposeOperations(
        [{ type: "UPSERT_REGION", region }],
        `Create soft region "${region.title}" from the current selection`,
      );
    },
    [proposeOperations, selectedElements],
  );

  const showFocus = useCallback(
    async (focus: CwmFocus, actor: CwmActor = "HUMAN") => {
      const current = workspaceRef.current;
      if (!current) throw new Error("CWM workspace is not ready");
      const objectIds = focus.objectIds.filter((id) => Boolean(current.objects[id]));
      const regionIds = focus.regionIds.filter((id) => Boolean(current.regions[id]));
      if (!objectIds.length && !regionIds.length) {
        throw new Error("Focus must reference an existing CWM object or region");
      }
      setEphemeralFocus({
        objectIds,
        regionIds,
        reason: focus.reason || `${actor === "AI" ? "AI" : "Human"} focus`,
      });
      setStatus({
        kind: "ready",
        message: `${actor === "AI" ? "AI" : "Human"} focus shown locally · not persisted`,
      });
    },
    [setEphemeralFocus],
  );

  const focusRegion = useCallback(
    async (region: CwmRegion, actor: CwmActor = "HUMAN") => {
      if (!api) return;
      const inRegion = api.getSceneElements().filter(
        (element) =>
          !element.isDeleted &&
          element.x + element.width >= region.bounds.x &&
          element.y + element.height >= region.bounds.y &&
          element.x <= region.bounds.x + region.bounds.width &&
          element.y <= region.bounds.y + region.bounds.height,
      );
      if (inRegion.length) {
        api.scrollToContent(inRegion, { fitToContent: true });
      } else {
        const state = api.getAppState();
        const zoom = state.zoom.value || 1;
        api.updateScene({
          appState: {
            scrollX: -region.bounds.x + (state.width / zoom - region.bounds.width) / 2,
            scrollY: -region.bounds.y + (state.height / zoom - region.bounds.height) / 2,
          },
        });
      }
      await showFocus(
        {
          objectIds: region.objectIds,
          regionIds: [region.id],
          reason: `${actor === "AI" ? "AI" : "Human"} focused region "${region.title}"`,
        },
        actor,
      );
    },
    [api, showFocus],
  );

  const acceptProposal = useCallback(
    async (proposal: CwmProposal) => {
      const current = workspaceRef.current;
      if (!api || !eligiblePath || !current) return;
      setBusyProposalId(proposal.id);
      try {
        // Confirmation is durable before any semantic scene materialization.
        const confirmed = await cwmApiClient.confirm({
          path: eligiblePath,
          headSequence: current.headSequence,
          actor: "HUMAN",
          proposalId: proposal.id,
        });
        const nextElements = materializeConfirmedOperations(
          api.getSceneElements(),
          proposal.operations,
          current,
        );
        api.updateScene({ elements: nextElements });
        const checkpoint = await cwmApiClient.checkpoint({
          path: eligiblePath,
          headSequence: confirmed.workspace.headSequence,
          actor: "HUMAN",
          scene: sceneEnvelope(api, nextElements),
          reason: `Accepted proposal ${proposal.id}`,
        });
        setWorkspace(checkpoint.workspace);
        setRecentEvents((value) => [...value, confirmed.event, checkpoint.event].slice(-100));
        setStatus({
          kind: "ready",
          message: `Proposal accepted and scene checkpointed · head ${checkpoint.workspace.headSequence}`,
        });
      } catch (error) {
        await refresh().catch(() => undefined);
        setStatus({ kind: "error", message: `Accept failed — ${errorMessage(error)}` });
      } finally {
        setBusyProposalId(null);
      }
    },
    [api, eligiblePath, refresh, setRecentEvents, setWorkspace],
  );

  const rejectProposal = useCallback(
    async (proposal: CwmProposal) => {
      const current = workspaceRef.current;
      if (!api || !eligiblePath || !current) return;
      setBusyProposalId(proposal.id);
      const withoutPreview = removeCwmPreviews(api.getSceneElements(), proposal.id);
      api.updateScene({ elements: withoutPreview });
      try {
        const rejected = await cwmApiClient.reject({
          path: eligiblePath,
          headSequence: current.headSequence,
          actor: "HUMAN",
          proposalId: proposal.id,
          reason: "Rejected in jWhiteboard review tray",
        });
        setWorkspace(rejected.workspace);
        setRecentEvents((value) => [...value, rejected.event].slice(-100));
        setStatus({
          kind: "ready",
          message: `Proposal rejected · head ${rejected.workspace.headSequence}`,
        });
      } catch (error) {
        api.updateScene({ elements: withoutPreview });
        if (error instanceof CwmApiError && error.status === 409) await refresh();
        setStatus({ kind: "error", message: `Reject failed — ${errorMessage(error)}` });
      } finally {
        setBusyProposalId(null);
      }
    },
    [api, eligiblePath, refresh, setRecentEvents, setWorkspace],
  );

  const checkpointScene = useCallback(async () => {
    const current = workspaceRef.current;
    if (!api || !eligiblePath || !current) throw new Error("CWM workspace is not ready");
    setConsolidationBusy(true);
    try {
      // Pending ghosts are review affordances, never accepted board content.
      const acceptedElements = removeCwmPreviews(api.getSceneElements());
      const checkpoint = await cwmApiClient.checkpoint({
        path: eligiblePath,
        headSequence: current.headSequence,
        actor: "HUMAN",
        scene: sceneEnvelope(api, acceptedElements),
        reason: "Explicit jWhiteboard checkpoint",
      });
      setWorkspace(checkpoint.workspace);
      setRecentEvents((value) => [...value, checkpoint.event].slice(-100));
      setStatus({
        kind: "ready",
        message: `Board checkpointed · head ${checkpoint.workspace.headSequence}`,
      });
      return checkpoint.workspace;
    } catch (error) {
      await refresh().catch(() => undefined);
      setStatus({ kind: "error", message: `Checkpoint failed — ${errorMessage(error)}` });
      throw error;
    } finally {
      setConsolidationBusy(false);
    }
  }, [api, eligiblePath, refresh, setRecentEvents, setWorkspace]);

  const consolidateSession = useCallback(async () => {
    const current = workspaceRef.current;
    if (!api || !eligiblePath || !current) throw new Error("CWM workspace is not ready");
    setConsolidationBusy(true);
    setHandoffPath(null);
    try {
      const sessionStartedAt = eventsRef.current
        .map((event) => event.occurredAt)
        .sort()[0];
      // Preview elements represent pending proposals and must never enter the accepted checkpoint.
      const acceptedElements = removeCwmPreviews(api.getSceneElements());
      const checkpoint = await cwmApiClient.checkpoint({
        path: eligiblePath,
        headSequence: current.headSequence,
        actor: "HUMAN",
        scene: sceneEnvelope(api, acceptedElements),
        reason: "Session consolidation checkpoint",
      });
      setWorkspace(checkpoint.workspace);
      setRecentEvents((value) => [...value, checkpoint.event].slice(-100));

      // Generate only after the atomic scene checkpoint, and consolidate against its new head.
      const consolidatedAt = new Date().toISOString();
      const markdown = renderCwmSessionMarkdown({
        workspace: checkpoint.workspace,
        boardPath: eligiblePath,
        ...(sessionStartedAt ? { sessionStartedAt } : {}),
        consolidatedAt,
      });
      const consolidated = await cwmApiClient.consolidate({
        path: eligiblePath,
        headSequence: checkpoint.workspace.headSequence,
        actor: "HUMAN",
        markdown,
      });
      const path = consolidated.handoffPath;
      if (!path) throw new Error("CWM backend did not return a handoff path");
      setWorkspace(consolidated.workspace);
      setRecentEvents((value) => [...value, consolidated.event].slice(-100));
      setHandoffPath(path);
      setStatus({
        kind: "ready",
        message: `Session consolidated to ${path} · head ${consolidated.workspace.headSequence}`,
      });
      return path;
    } catch (error) {
      await refresh().catch(() => undefined);
      setStatus({ kind: "error", message: `Consolidation failed — ${errorMessage(error)}` });
      throw error;
    } finally {
      setConsolidationBusy(false);
    }
  }, [api, eligiblePath, refresh, setRecentEvents, setWorkspace]);

  const getSceneSnapshot = useCallback((): CwmSceneSnapshot | null => {
    const current = workspaceRef.current;
    if (!api) return null;
    const snapshotWorkspace = current ? { ...current, focus: focusRef.current } : null;
    const anchored = anchoredSelectionRef.current;
    const anchoredStillFresh =
      anchored && Date.now() - anchored.capturedAt < ANCHORED_SELECTION_TTL_MS
        ? { selection: anchored.selection, selectedItems: anchored.selectedItems }
        : null;
    if (anchored && !anchoredStillFresh) {
      anchoredSelectionRef.current = null;
    }

    const snapshot = createBoundedSceneSnapshot({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      loadedFile,
      workspace: snapshotWorkspace,
      pendingProposal: Object.values(current?.proposals ?? {}).find(
        (proposal) => proposal.status === "PENDING",
      ),
      anchoredSelection: anchoredStillFresh,
    });

    // Refresh the anchor whenever Excalidraw reports a live selection.
    if (snapshot.selectionSource === "live" && snapshot.selectedItems.length > 0) {
      anchoredSelectionRef.current = {
        selection: snapshot.selection,
        selectedItems: snapshot.selectedItems,
        capturedAt: Date.now(),
      };
    }
    return snapshot;
  }, [api, loadedFile]);

  const getGuiSnapshot = useCallback(
    (): Record<string, unknown> => ({
      cwmReady: status.kind === "ready",
      eligibleBoardPath: eligiblePath,
      workspaceMode: workspaceRef.current?.mode ?? null,
      deicticContext: deicticContextRef.current,
      ...(getSceneSnapshot() ?? {
        loadedFile,
        selection: [],
        selectedItems: [],
        focusedRegions: [],
        openingBrief: null,
        pendingProposal: null,
        scenePreview: [],
      }),
    }),
    [eligiblePath, getSceneSnapshot, loadedFile, status.kind],
  );

  return {
    eligiblePath,
    workspace,
    focus,
    events,
    status,
    selectedElements,
    selectedObjects,
    pendingProposals,
    busyProposalId,
    mutationBusy,
    consolidationBusy,
    handoffPath,
    recallToBoard,
    promoteSelection,
    createRegion,
    showFocus,
    focusRegion,
    acceptProposal,
    rejectProposal,
    checkpointScene,
    consolidateSession,
    proposeOperations,
    setDeicticContext,
    getSceneSnapshot,
    getGuiSnapshot,
  };
}

export type CwmWorkspaceController = ReturnType<typeof useCwmWorkspace>;
