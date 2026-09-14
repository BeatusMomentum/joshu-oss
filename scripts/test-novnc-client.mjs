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

const watcher = fs.readFileSync(path.join(root, "scripts", "camofox-vnc-watcher.sh"), "utf8");
assert.match(watcher, /HITL_VNC_REATTACH/);
assert.match(watcher, /X11VNC_NOXDAMAGE/);
assert.match(watcher, /X11VNC_THREADS/);

console.log("novnc-client fixtures: ok");
