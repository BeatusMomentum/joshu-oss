import assert from "node:assert/strict";
import test from "node:test";

import {
  alignFinalTranscript,
  boundedDeicticContext,
  contextFromResolution,
  proposalDecisionFromFinalUtterance,
  resolveDeicticReference,
  type DeicticElement,
  type PointerTrace,
} from "./deicticResolver";
import {
  downsamplePointerPoints,
  POINTER_TRACE_MAX_POINTS,
  POINTER_TRACE_WINDOW_MS,
} from "./useJoshuPointer";

const elements: DeicticElement[] = [
  { id: "inside", x: 40, y: 40, width: 20, height: 20 },
  { id: "crossed", x: 160, y: 40, width: 30, height: 30 },
  { id: "far", x: 500, y: 500, width: 20, height: 20 },
];

const trace = (
  id: string,
  points: Array<[number, number, number]>,
): PointerTrace => ({
  id,
  points: points.map(([x, y, t]) => ({ x, y, t })),
  startedAt: points[0]?.[2] ?? 0,
  endedAt: points.at(-1)?.[2] ?? 0,
});

test("explicit selection wins over pointer geometry", () => {
  const resolved = resolveDeicticReference({
    trace: trace("selection", [[0, 0, 100], [500, 500, 200]]),
    elements,
    selectedElementIds: ["far"],
    cwmObjects: [{ id: "object-far", sceneBinding: { elementIds: ["far"] } }],
  });

  assert.equal(resolved.method, "explicit-selection");
  assert.equal(resolved.confidence, 1);
  assert.deepEqual(resolved.candidateElementIds, ["far"]);
  assert.deepEqual(resolved.cwmObjectIds, ["object-far"]);
  assert.equal(resolved.groundingRequired, false);
});

test("a closed lasso around an element center is high confidence", () => {
  const resolved = resolveDeicticReference({
    trace: trace("lasso", [
      [20, 20, 100],
      [90, 20, 120],
      [90, 90, 140],
      [20, 90, 160],
      [22, 22, 180],
    ]),
    elements,
    cwmObjects: [{ id: "claim-inside", sceneBinding: { elementIds: ["inside"] } }],
  });

  assert.equal(resolved.method, "closed-lasso");
  assert.ok(resolved.confidence >= 0.7);
  assert.deepEqual(resolved.candidateElementIds, ["inside"]);
  assert.deepEqual(resolved.cwmObjectIds, ["claim-inside"]);
  assert.equal(resolved.traceTiming.durationMs, 80);
});

test("a closed lasso touching element bounds resolves at high confidence", () => {
  const resolved = resolveDeicticReference({
    trace: trace("bounds-lasso", [
      [35, 35, 100],
      [47, 35, 120],
      [47, 47, 140],
      [35, 47, 160],
      [36, 36, 180],
    ]),
    elements,
  });

  assert.equal(resolved.method, "closed-lasso");
  assert.deepEqual(resolved.candidateElementIds, ["inside"]);
  assert.ok(resolved.confidence >= 0.7);
});

test("pass-through traces remain below the grounding threshold", () => {
  const resolved = resolveDeicticReference({
    trace: trace("sweep", [[120, 55, 1_000], [220, 55, 1_100]]),
    elements,
  });

  assert.equal(resolved.method, "pass-through");
  assert.deepEqual(resolved.candidateElementIds, ["crossed"]);
  assert.ok(resolved.confidence < 0.7);
  assert.equal(resolved.groundingRequired, true);
});

test("final transcripts align only inside the 1200ms window", () => {
  const resolved = resolveDeicticReference({
    trace: trace("timing", [[0, 0, 2_000], [10, 10, 2_100]]),
    elements,
    selectedElementIds: ["inside"],
  });

  assert.equal(alignFinalTranscript("this one", 3_300, resolved)?.utterance, "this one");
  assert.equal(alignFinalTranscript("too late", 3_301, resolved), null);
  assert.equal(alignFinalTranscript("too early", 2_099, resolved), null);
});

test("snapshot deictic context is bounded and excludes raw trace points", () => {
  const resolved = resolveDeicticReference({
    trace: trace("bounded", [[0, 0, 2_000], [10, 10, 2_100]]),
    elements: [{ id: "x".repeat(200), x: 0, y: 0, width: 20, height: 20 }],
    selectedElementIds: ["x".repeat(200)],
  });
  const bounded = boundedDeicticContext(contextFromResolution(resolved));

  assert.ok(bounded.candidateElementIds[0]!.length <= 80);
  assert.equal("points" in bounded, false);
});

test("spoken review decisions require exact final utterances", () => {
  assert.equal(proposalDecisionFromFinalUtterance("accept proposal"), "accept");
  assert.equal(proposalDecisionFromFinalUtterance(" Reject Proposal "), "reject");
  assert.equal(proposalDecisionFromFinalUtterance("accept the proposal"), null);
  assert.equal(proposalDecisionFromFinalUtterance("accept proposal please"), null);
  assert.equal(proposalDecisionFromFinalUtterance("accept proposal."), null);
});

test("pointer traces retain no more than 500 points from 30 seconds", () => {
  const points = Array.from({ length: 2_000 }, (_, index) => ({
    x: index,
    y: index,
    t: index * 20,
  }));
  const now = points.at(-1)!.t;
  const sampled = downsamplePointerPoints(points, now);

  assert.ok(sampled.length <= POINTER_TRACE_MAX_POINTS);
  assert.ok(sampled.every((point) => point.t >= now - POINTER_TRACE_WINDOW_MS));
  assert.equal(sampled.at(-1)?.t, now);
});
