/**
 * Canvas fraction → CSS pixels for CDP mouse events.
 * Usage: npx tsx scripts/test-screencast-coords.ts
 */
import assert from "node:assert/strict";
import { normalizedPointToCss } from "../src/browserScreencastCoords.ts";
import { VIEWPORT_AREA, viewportForBox } from "../src/browserViewport.ts";
import { screencastInputAllowed, noteBrowserAgentPhase } from "../src/browserAgent.ts";

const mid = normalizedPointToCss(0.5, 0.25, 1024, 768);
assert.deepEqual(mid, { x: 512, y: 192 });

const origin = normalizedPointToCss(-1, 2, 100, 100);
assert.deepEqual(origin, { x: 0, y: 100 });

assert.equal(normalizedPointToCss(0.5, 0.5, 0, 768), null);
assert.equal(normalizedPointToCss(Number.NaN, 0.2, 800, 600), null);

const landscape = viewportForBox(1024, 768);
assert.ok(landscape);
assert.ok(Math.abs(landscape.width / landscape.height - 1024 / 768) < 0.08);
assert.ok(Math.abs(landscape.width * landscape.height - VIEWPORT_AREA) / VIEWPORT_AREA < 0.08);

const portrait = viewportForBox(390, 700);
assert.ok(portrait);
assert.ok(portrait.height > portrait.width);
assert.ok(Math.abs(portrait.width * portrait.height - VIEWPORT_AREA) / VIEWPORT_AREA < 0.12);

const wide = viewportForBox(1100, 480);
assert.ok(wide);
assert.ok(wide.width > wide.height);
assert.equal(viewportForBox(10, 800), null);

noteBrowserAgentPhase("running");
assert.equal(screencastInputAllowed("/tmp/joshu-screencast-coords-no-handoff"), false);
noteBrowserAgentPhase("idle");
assert.equal(screencastInputAllowed("/tmp/joshu-screencast-coords-no-handoff"), true);
noteBrowserAgentPhase("paused");
assert.equal(screencastInputAllowed("/tmp/joshu-screencast-coords-no-handoff"), true);

console.log("test-screencast-coords: ok");
