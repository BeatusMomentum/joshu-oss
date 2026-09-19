#!/usr/bin/env npx tsx
/**
 * Guard rails for the vendored noVNC 1.7 client + Joshu URL split.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildNovncLibraryUrl,
  buildNovncWebsocketPath,
  buildNoVncStandaloneUrl,
} from "../src/camofox.ts";

const root = process.cwd();
const vendor = path.join(root, "public", "vendor", "novnc");
const version = fs.readFileSync(path.join(vendor, "VERSION"), "utf8").trim();
assert.equal(version, "1.7.0");

const rfb = fs.readFileSync(path.join(vendor, "core", "rfb.js"), "utf8");
assert.match(rfb, /noVNC: HTML5 VNC client/);
assert.match(rfb, /class RFB/);
assert.match(rfb, /ZlibDecoder/);
assert.equal(fs.existsSync(path.join(vendor, "vendor", "pako", "lib", "zlib", "inflate.js")), true);
assert.equal(fs.existsSync(path.join(vendor, "LICENSE.txt")), true);

assert.equal(buildNovncLibraryUrl("/joshu"), "/joshu/vendor/novnc");
assert.equal(buildNovncWebsocketPath("/joshu/novnc"), "/joshu/novnc/websockify");
assert.match(buildNoVncStandaloneUrl("/joshu"), /camofox-viewer\.html/);

const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
assert.match(appJs, /loadNovncRfb/);
assert.match(appJs, /attachVncLocalGestures/);
assert.doesNotMatch(appJs, /\$\{clientBaseUrl.*\}\/core\/rfb\.js/);

const handoffJs = fs.readFileSync(path.join(root, "public", "handoff.js"), "utf8");
assert.match(handoffJs, /attachVncLocalGestures/);
assert.match(handoffJs, /skipWheel: true/);
assert.doesNotMatch(handoffJs, /core\/rfb\.js`/);

const clientJs = fs.readFileSync(path.join(root, "public", "vnc-client.js"), "utf8");
assert.match(clientJs, /NOVNC_LIBRARY_VERSION = "1\.7\.0"/);

const gesturesJs = fs.readFileSync(path.join(root, "public", "vnc-gestures.js"), "utf8");
assert.match(gesturesJs, /MAX_SCALE = 5/);
assert.match(gesturesJs, /gesturestart/);
assert.match(gesturesJs, /classifyTwoFingerMode/);
assert.match(gesturesJs, /DOMINANCE/);

const { classifyTwoFingerMode } = await import(
  new URL("../public/vnc-gestures.js", import.meta.url).href
);

function gestureFixture(overrides = {}) {
  return {
    mode: null,
    startDist: 100,
    startMidX: 200,
    startMidY: 300,
    startScale: 1,
    ...overrides,
  };
}

// Vertical two-finger drag at 1× → scroll (not pinch from tiny finger spread).
assert.equal(
  classifyTwoFingerMode(
    { dist: 102, midX: 200, midY: 330 },
    gestureFixture(),
    1,
  ),
  "scroll",
);

// Clear pinch at 1× → zoom mode.
assert.equal(
  classifyTwoFingerMode(
    { dist: 130, midX: 200, midY: 302 },
    gestureFixture(),
    1,
  ),
  "pinch",
);

// Zoomed: midpoint drag → pan.
assert.equal(
  classifyTwoFingerMode(
    { dist: 100, midX: 230, midY: 300 },
    gestureFixture({ startScale: 2 }),
    2,
  ),
  "pan",
);

// Mode stays locked once set.
assert.equal(
  classifyTwoFingerMode(
    { dist: 140, midX: 200, midY: 340 },
    gestureFixture({ mode: "scroll" }),
    1,
  ),
  "scroll",
);

const watcher = fs.readFileSync(path.join(root, "scripts", "camofox-vnc-watcher.sh"), "utf8");
assert.match(watcher, /HITL_VNC_REATTACH/);
assert.match(watcher, /X11VNC_NOXDAMAGE/);
assert.match(watcher, /X11VNC_THREADS/);

console.log("novnc-client fixtures: ok");
