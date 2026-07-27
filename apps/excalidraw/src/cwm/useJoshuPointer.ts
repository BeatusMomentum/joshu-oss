import type { CwmWorkspace } from "@joshu/whiteboard-cwm";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  alignFinalTranscript,
  contextFromResolution,
  resolveDeicticReference,
  type DeicticContext,
  type DeicticResolution,
  type PointerTrace,
  type PointerTracePoint,
} from "./deicticResolver";

export const POINTER_TRACE_WINDOW_MS = 30_000;
export const POINTER_TRACE_MAX_POINTS = 500;
const POINTER_SAMPLE_INTERVAL_MS = POINTER_TRACE_WINDOW_MS / POINTER_TRACE_MAX_POINTS;
const POINTER_FADE_MS = 1_000;
const RECENT_DEICTIC_CONTEXT_LIMIT = 6;

export interface FadingPointerTrace {
  readonly trace: PointerTrace;
  readonly fadeUntil: number;
}

interface UseJoshuPointerInput {
  readonly api: ExcalidrawImperativeAPI | null;
  readonly workspace: CwmWorkspace | null;
  readonly onDeicticContext: (context: DeicticContext | null) => void;
}

/** Keep at most 500 evenly distributed points from the latest 30 seconds. */
export function downsamplePointerPoints(
  points: readonly PointerTracePoint[],
  now = points.at(-1)?.t ?? Date.now(),
): PointerTracePoint[] {
  const recent = points.filter((point) => point.t >= now - POINTER_TRACE_WINDOW_MS);
  if (recent.length <= POINTER_TRACE_MAX_POINTS) return recent;

  const sampled: PointerTracePoint[] = [];
  const last = recent.length - 1;
  for (let index = 0; index < POINTER_TRACE_MAX_POINTS; index += 1) {
    sampled.push(recent[Math.round((index * last) / (POINTER_TRACE_MAX_POINTS - 1))]!);
  }
  return sampled;
}

function scenePoint(
  event: ReactPointerEvent<HTMLElement>,
  api: ExcalidrawImperativeAPI,
  t: number,
): PointerTracePoint {
  const state = api.getAppState();
  const zoom = Math.max(Number(state.zoom?.value) || 1, 0.01);
  const offsetLeft = Number.isFinite(state.offsetLeft) ? state.offsetLeft : 0;
  const offsetTop = Number.isFinite(state.offsetTop) ? state.offsetTop : 0;
  return {
    x: (event.clientX - offsetLeft) / zoom - state.scrollX,
    y: (event.clientY - offsetTop) / zoom - state.scrollY,
    t,
  };
}

function stopCanvasPointerEvent(event: ReactPointerEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

export function useJoshuPointer({
  api,
  workspace,
  onDeicticContext,
}: UseJoshuPointerInput) {
  const [enabled, setEnabled] = useState(false);
  const [activeTrace, setActiveTrace] = useState<PointerTrace | null>(null);
  const [fadingTraces, setFadingTraces] = useState<readonly FadingPointerTrace[]>([]);
  const [latestResolution, setLatestResolution] = useState<DeicticResolution | null>(null);
  const [recentContexts, setRecentContexts] = useState<readonly DeicticContext[]>([]);
  const activeRef = useRef<PointerTrace | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const latestResolutionRef = useRef<DeicticResolution | null>(null);

  const publishContext = useCallback(
    (context: DeicticContext) => {
      setRecentContexts((current) => [context, ...current].slice(0, RECENT_DEICTIC_CONTEXT_LIMIT));
      onDeicticContext(context);
    },
    [onDeicticContext],
  );

  const cancelActiveTrace = useCallback(() => {
    activeRef.current = null;
    activePointerIdRef.current = null;
    setActiveTrace(null);
  }, []);

  useEffect(() => {
    if (!enabled) cancelActiveTrace();
  }, [cancelActiveTrace, enabled]);

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !api || event.button !== 0) return;
      stopCanvasPointerEvent(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      const now = Date.now();
      const point = scenePoint(event, api, now);
      const next: PointerTrace = {
        id: `pointer-${crypto.randomUUID()}`,
        points: [point],
        startedAt: now,
        endedAt: now,
      };
      activePointerIdRef.current = event.pointerId;
      activeRef.current = next;
      setActiveTrace(next);
    },
    [api, enabled],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !api || activePointerIdRef.current !== event.pointerId) return;
      stopCanvasPointerEvent(event);
      const current = activeRef.current;
      if (!current) return;
      const now = Date.now();
      const previous = current.points.at(-1);
      if (previous && now - previous.t < POINTER_SAMPLE_INTERVAL_MS) return;
      const points = downsamplePointerPoints([...current.points, scenePoint(event, api, now)], now);
      const next = { ...current, points, endedAt: now };
      activeRef.current = next;
      setActiveTrace(next);
    },
    [api, enabled],
  );

  const finishTrace = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !api || activePointerIdRef.current !== event.pointerId) return;
      stopCanvasPointerEvent(event);
      const current = activeRef.current;
      if (!current) return;

      const now = Date.now();
      const finalPoint = scenePoint(event, api, now);
      const points = downsamplePointerPoints([...current.points, finalPoint], now);
      const trace: PointerTrace = { ...current, points, endedAt: now };
      const state = api.getAppState();
      const resolved = resolveDeicticReference({
        trace,
        elements: api.getSceneElements(),
        selectedElementIds: Object.keys(state.selectedElementIds).filter(
          (id) => state.selectedElementIds[id],
        ),
        cwmObjects: Object.values(workspace?.objects ?? {}),
      });

      activeRef.current = null;
      activePointerIdRef.current = null;
      latestResolutionRef.current = resolved;
      setActiveTrace(null);
      setLatestResolution(resolved);
      setFadingTraces((currentTraces) => [
        ...currentTraces,
        { trace, fadeUntil: now + POINTER_FADE_MS },
      ].slice(-4));
      publishContext(contextFromResolution(resolved));
      window.setTimeout(() => {
        setFadingTraces((currentTraces) =>
          currentTraces.filter((item) => item.fadeUntil > Date.now()),
        );
      }, POINTER_FADE_MS + 50);

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [api, enabled, publishContext, workspace],
  );

  const handlePointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      stopCanvasPointerEvent(event);
      cancelActiveTrace();
    },
    [cancelActiveTrace],
  );

  const alignTranscript = useCallback(
    (utterance: string, finalizedAt = Date.now()): DeicticContext | null => {
      const resolved = latestResolutionRef.current;
      if (!resolved) return null;
      const aligned = alignFinalTranscript(utterance, finalizedAt, resolved);
      if (aligned) publishContext(aligned);
      return aligned;
    },
    [publishContext],
  );

  return {
    enabled,
    setEnabled,
    activeTrace,
    fadingTraces,
    latestResolution,
    recentContexts,
    alignTranscript,
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture: finishTrace,
    handlePointerCancelCapture,
  };
}

export type JoshuPointerController = ReturnType<typeof useJoshuPointer>;
