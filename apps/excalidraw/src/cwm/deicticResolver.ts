export const DEICTIC_ALIGNMENT_WINDOW_MS = 1_200;
export const DEICTIC_MAX_CANDIDATES = 20;

export interface PointerTracePoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

export interface PointerTrace {
  readonly id: string;
  readonly points: readonly PointerTracePoint[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface DeicticElement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isDeleted?: boolean;
}

export interface DeicticObjectBinding {
  readonly id: string;
  readonly sceneBinding?: {
    readonly elementIds: readonly string[];
  };
}

export type DeicticMethod =
  | "explicit-selection"
  | "closed-lasso"
  | "pass-through"
  | "sweep"
  | "none";

export interface DeicticResolution {
  readonly candidateElementIds: readonly string[];
  readonly cwmObjectIds: readonly string[];
  readonly confidence: number;
  readonly method: DeicticMethod;
  readonly groundingRequired: boolean;
  readonly traceTiming: {
    readonly traceId: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly durationMs: number;
  };
}

export interface DeicticContext extends DeicticResolution {
  readonly utterance: string | null;
  readonly transcriptTiming: {
    readonly finalizedAt: number;
    readonly alignmentDeltaMs: number;
  } | null;
}

interface ResolverInput {
  readonly trace: PointerTrace;
  readonly elements: readonly DeicticElement[];
  readonly selectedElementIds?: readonly string[];
  readonly cwmObjects?: readonly DeicticObjectBinding[];
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

function traceTiming(trace: PointerTrace): DeicticResolution["traceTiming"] {
  return {
    traceId: trace.id.slice(0, 80),
    startedAt: finite(trace.startedAt),
    endedAt: finite(trace.endedAt),
    durationMs: Math.max(0, finite(trace.endedAt - trace.startedAt)),
  };
}

function center(element: DeicticElement): PointerTracePoint {
  return {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
    t: 0,
  };
}

function distance(a: PointerTracePoint, b: PointerTracePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInPolygon(point: PointerTracePoint, polygon: readonly PointerTracePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentIntersectsBounds(
  a: PointerTracePoint,
  b: PointerTracePoint,
  element: DeicticElement,
): boolean {
  const minX = Math.min(element.x, element.x + element.width);
  const maxX = Math.max(element.x, element.x + element.width);
  const minY = Math.min(element.y, element.y + element.height);
  const maxY = Math.max(element.y, element.y + element.height);
  const inside = (point: PointerTracePoint) =>
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  if (inside(a) || inside(b)) return true;

  // Liang-Barsky clipping answers whether any part of the finite segment enters the bounds.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - minX, maxX - a.x, a.y - minY, maxY - a.y];
  let enter = 0;
  let leave = 1;
  for (let index = 0; index < p.length; index += 1) {
    if (p[index] === 0) {
      if (q[index]! < 0) return false;
      continue;
    }
    const ratio = q[index]! / p[index]!;
    if (p[index]! < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return false;
  }
  return true;
}

function distanceToSegment(
  point: PointerTracePoint,
  a: PointerTracePoint,
  b: PointerTracePoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return distance(point, a);
  const projected = ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, projected));
  return distance(point, { x: a.x + clamped * dx, y: a.y + clamped * dy, t: 0 });
}

function mappedObjectIds(
  elementIds: readonly string[],
  objects: readonly DeicticObjectBinding[],
): string[] {
  const candidates = new Set(elementIds);
  return objects
    .filter((object) => object.sceneBinding?.elementIds.some((id) => candidates.has(id)))
    .map((object) => object.id)
    .slice(0, DEICTIC_MAX_CANDIDATES);
}

function resolution(
  trace: PointerTrace,
  elementIds: readonly string[],
  objects: readonly DeicticObjectBinding[],
  method: DeicticMethod,
  confidence: number,
): DeicticResolution {
  const candidateElementIds = [...new Set(elementIds)].slice(0, DEICTIC_MAX_CANDIDATES);
  return {
    candidateElementIds,
    cwmObjectIds: mappedObjectIds(candidateElementIds, objects),
    confidence,
    method,
    groundingRequired: confidence < 0.7,
    traceTiming: traceTiming(trace),
  };
}

/** Pure, deterministic resolution of selection, lasso, and sweep references. */
export function resolveDeicticReference(input: ResolverInput): DeicticResolution {
  const elements = input.elements.filter((element) => !element.isDeleted);
  const objects = input.cwmObjects ?? [];
  const selected = new Set(input.selectedElementIds ?? []);
  const selectedCandidates = elements.filter((element) => selected.has(element.id)).map((element) => element.id);
  if (selectedCandidates.length > 0) {
    return resolution(input.trace, selectedCandidates, objects, "explicit-selection", 1);
  }

  const points = input.trace.points;
  if (points.length < 2) return resolution(input.trace, [], objects, "none", 0);

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const diagonal = Math.hypot(width, height);
  const isClosed =
    points.length >= 4 &&
    width >= 8 &&
    height >= 8 &&
    distance(points[0]!, points[points.length - 1]!) <= Math.max(24, diagonal * 0.22);

  if (isClosed) {
    const enclosed = elements
      .filter((element) => {
        const minX = Math.min(element.x, element.x + element.width);
        const maxX = Math.max(element.x, element.x + element.width);
        const minY = Math.min(element.y, element.y + element.height);
        const maxY = Math.max(element.y, element.y + element.height);
        const boundsPoints: PointerTracePoint[] = [
          { x: minX, y: minY, t: 0 },
          { x: maxX, y: minY, t: 0 },
          { x: maxX, y: maxY, t: 0 },
          { x: minX, y: maxY, t: 0 },
        ];
        return (
          pointInPolygon(center(element), points) ||
          boundsPoints.some((point) => pointInPolygon(point, points))
        );
      })
      .map((element) => element.id);
    if (enclosed.length > 0) {
      return resolution(input.trace, enclosed, objects, "closed-lasso", 0.92);
    }
  }

  const passedThrough = elements
    .filter((element) =>
      points.slice(1).some((point, index) =>
        segmentIntersectsBounds(points[index]!, point, element),
      ),
    )
    .map((element) => element.id);
  if (passedThrough.length > 0) {
    return resolution(input.trace, passedThrough, objects, "pass-through", 0.62);
  }

  const sweepRadius = Math.max(24, Math.min(80, diagonal * 0.12));
  const swept = elements
    .filter((element) => {
      const elementCenter = center(element);
      return points.slice(1).some(
        (point, index) => distanceToSegment(elementCenter, points[index]!, point) <= sweepRadius,
      );
    })
    .map((element) => element.id);
  return resolution(input.trace, swept, objects, swept.length ? "sweep" : "none", swept.length ? 0.52 : 0);
}

export function contextFromResolution(resolved: DeicticResolution): DeicticContext {
  return { ...resolved, utterance: null, transcriptTiming: null };
}

/** Small snapshot-safe copy; raw trace points remain UI-only. */
export function boundedDeicticContext(context: DeicticContext): DeicticContext {
  return {
    ...context,
    candidateElementIds: context.candidateElementIds
      .slice(0, DEICTIC_MAX_CANDIDATES)
      .map((id) => id.slice(0, 80)),
    cwmObjectIds: context.cwmObjectIds
      .slice(0, DEICTIC_MAX_CANDIDATES)
      .map((id) => id.slice(0, 80)),
    utterance: context.utterance?.slice(0, 400) ?? null,
  };
}

/** Align only a final transcript that follows the most recent trace within the strict window. */
export function alignFinalTranscript(
  utterance: string,
  finalizedAt: number,
  resolved: DeicticResolution,
): DeicticContext | null {
  const delta = finalizedAt - resolved.traceTiming.endedAt;
  if (!utterance.trim() || delta < 0 || delta > DEICTIC_ALIGNMENT_WINDOW_MS) return null;
  return {
    ...resolved,
    utterance: utterance.trim().slice(0, 400),
    transcriptTiming: {
      finalizedAt,
      alignmentDeltaMs: delta,
    },
  };
}

/** Approval language is intentionally tiny and exact; ambiguous variants do nothing. */
export function proposalDecisionFromFinalUtterance(
  utterance: string,
): "accept" | "reject" | null {
  const normalized = utterance.trim().toLowerCase();
  if (normalized === "accept proposal") return "accept";
  if (normalized === "reject proposal") return "reject";
  return null;
}
