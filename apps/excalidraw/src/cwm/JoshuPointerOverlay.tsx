import type { CwmWorkspace } from "@joshu/whiteboard-cwm";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useState, type RefObject } from "react";

import type { DeicticResolution, PointerTrace } from "./deicticResolver";
import type { FadingPointerTrace } from "./useJoshuPointer";

interface JoshuPointerOverlayProps {
  readonly api: ExcalidrawImperativeAPI | null;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly activeTrace: PointerTrace | null;
  readonly fadingTraces: readonly FadingPointerTrace[];
  readonly resolution: DeicticResolution | null;
  readonly workspace: CwmWorkspace | null;
}

interface ViewportTransform {
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

function getTransform(
  api: ExcalidrawImperativeAPI | null,
  container: HTMLElement | null,
): ViewportTransform {
  if (!api || !container) {
    return { zoom: 1, scrollX: 0, scrollY: 0, offsetX: 0, offsetY: 0 };
  }
  const state = api.getAppState();
  const bounds = container.getBoundingClientRect();
  return {
    zoom: Math.max(Number(state.zoom?.value) || 1, 0.01),
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    offsetX: state.offsetLeft - bounds.left,
    offsetY: state.offsetTop - bounds.top,
  };
}

function viewportPoint(
  point: { readonly x: number; readonly y: number },
  transform: ViewportTransform,
): { x: number; y: number } {
  return {
    x: (point.x + transform.scrollX) * transform.zoom + transform.offsetX,
    y: (point.y + transform.scrollY) * transform.zoom + transform.offsetY,
  };
}

function trailPoints(trace: PointerTrace, transform: ViewportTransform): string {
  return trace.points
    .map((point) => {
      const viewport = viewportPoint(point, transform);
      return `${viewport.x},${viewport.y}`;
    })
    .join(" ");
}

function elementRect(element: ExcalidrawElement, transform: ViewportTransform) {
  const origin = viewportPoint(element, transform);
  return {
    x: Math.min(origin.x, origin.x + element.width * transform.zoom),
    y: Math.min(origin.y, origin.y + element.height * transform.zoom),
    width: Math.abs(element.width * transform.zoom),
    height: Math.abs(element.height * transform.zoom),
  };
}

/** Ephemeral sibling SVG: pointer trails and focus never enter Excalidraw scene state. */
export function JoshuPointerOverlay({
  api,
  containerRef,
  activeTrace,
  fadingTraces,
  resolution,
  workspace,
}: JoshuPointerOverlayProps) {
  const [now, setNow] = useState(() => Date.now());
  const [transform, setTransform] = useState<ViewportTransform>(() =>
    getTransform(api, containerRef.current),
  );

  useEffect(() => {
    const update = () => {
      setNow(Date.now());
      setTransform(getTransform(api, containerRef.current));
    };
    update();
    const timer = window.setInterval(update, 50);
    return () => window.clearInterval(timer);
  }, [api, containerRef]);

  const sceneElements = api?.getSceneElements() ?? [];
  const elementsById = useMemo(
    () => new Map(sceneElements.filter((element) => !element.isDeleted).map((element) => [element.id, element])),
    [sceneElements],
  );
  const candidateIds = new Set(resolution?.candidateElementIds ?? []);
  const focusObjectIds = new Set(workspace?.focus?.objectIds ?? []);
  const focusedElementIds = new Set(
    Object.values(workspace?.objects ?? {})
      .filter((object) => focusObjectIds.has(object.id))
      .flatMap((object) => [...(object.sceneBinding?.elementIds ?? [])]),
  );

  return (
    <svg className="joshu-pointer-overlay" aria-hidden="true">
      {workspace?.focus?.regionIds.map((regionId) => {
        const region = workspace.regions[regionId];
        if (!region) return null;
        const origin = viewportPoint(region.bounds, transform);
        return (
          <rect
            key={`focus-region-${region.id}`}
            className="joshu-focus-rect joshu-focus-region"
            x={origin.x}
            y={origin.y}
            width={region.bounds.width * transform.zoom}
            height={region.bounds.height * transform.zoom}
            rx={8}
          />
        );
      })}
      {[...focusedElementIds].map((elementId) => {
        const element = elementsById.get(elementId);
        if (!element) return null;
        return (
          <rect
            key={`focus-${elementId}`}
            className="joshu-focus-rect"
            {...elementRect(element, transform)}
            rx={6}
          />
        );
      })}
      {[...candidateIds].map((elementId) => {
        const element = elementsById.get(elementId);
        if (!element) return null;
        return (
          <rect
            key={`candidate-${elementId}`}
            className={
              resolution?.groundingRequired
                ? "joshu-candidate-rect is-low-confidence"
                : "joshu-candidate-rect"
            }
            {...elementRect(element, transform)}
            rx={6}
          />
        );
      })}
      {fadingTraces.map(({ trace, fadeUntil }) => (
        <polyline
          key={trace.id}
          className="joshu-pointer-trail"
          points={trailPoints(trace, transform)}
          opacity={Math.max(0, Math.min(1, (fadeUntil - now) / 1_000))}
        />
      ))}
      {activeTrace && (
        <polyline
          className="joshu-pointer-trail is-active"
          points={trailPoints(activeTrace, transform)}
        />
      )}
    </svg>
  );
}
