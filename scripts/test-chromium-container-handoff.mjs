#!/usr/bin/env npx tsx
/**
 * Local proof against the shared Chromium container (not system Chrome):
 * health, CDP, noVNC websocket, overlay fill, handoff lock, then complete.
 *
 * Expects scripts/ensure-camofox-container.sh to have started camofox-hitl.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { ChromiumCdpSession } from "../src/chromiumSession.ts";
import {
  completeHandoff,
  createHandoff,
  handoffUrlForRecord,
  isBrowserHandoffLocked,
} from "../src/browserHandoff/store.ts";

const controlUrl = process.env.CAMOFOX_URL || "http://127.0.0.1:9377";
const cdpUrl = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";
const vncPort = Number(process.env.BROWSER_VNC_PORT || "6080");

const health = await fetch(new URL("/health", controlUrl));
const body = await health.json();
assert.equal(health.status, 200, JSON.stringify(body));
assert.equal(body.engine, "chromium");
assert.equal(body.browserConnected, true);
console.log("container health: ok", body);

const version = await fetch(new URL("/json/version", cdpUrl));
assert.equal(version.status, 200);
const versionBody = await version.json();
assert.ok(versionBody.webSocketDebuggerUrl, JSON.stringify(versionBody));
console.log("cdp version: ok", versionBody.Browser || versionBody.browser);

await new Promise((resolve, reject) => {
  const socket = net.connect(vncPort, "127.0.0.1");
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error("websockify handshake timed out"));
  }, 5000);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("latin1");
    if (buf.includes("101") && buf.includes("RFB")) {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    }
  });
  socket.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  socket.on("connect", () => {
    socket.write(
      [
        "GET /websockify HTTP/1.1",
        "Host: 127.0.0.1:6080",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
});
console.log("novnc websockify: ok");

const session = new ChromiumCdpSession({
  cdpUrl,
  controlUrl,
  sessionKey: "hitl-main",
  singleTab: true,
  viewportWidth: 1024,
  viewportHeight: 768,
});
const html = `<!doctype html><title>Handoff proof</title><form>
  <label>Email <input id="email" name="email" type="email" placeholder="Email"></label>
  <button type="submit">Continue</button>
</form>`;
const tab = await session.ensureTab(`data:text/html,${encodeURIComponent(html)}`, { navigateExisting: true });
assert.ok(tab.url.includes("data:text/html"), tab.url);

const second = await chromium.connectOverCDP(cdpUrl);
const shared = second.contexts()[0]?.pages().find((page) => page.url().includes("data:text/html"));
assert.ok(shared, "second CDP client did not see the staged page");
await second.close();
console.log("shared page: ok", tab.url);

const catalog = await session.listFormFields();
const email = catalog.fields.find((field) => field.type === "email");
assert.ok(email, JSON.stringify(catalog.fields));
const filled = await session.fillForm({ fields: [{ id: email.id, value: "owner@example.com" }] });
assert.equal(filled.filled, 1, JSON.stringify(filled));
console.log("overlay fill: ok");

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-cdp-handoff-"));
try {
  const record = createHandoff(projectRoot, {
    pageUrl: tab.url,
    pageTitle: tab.title || "Handoff proof",
    instructions: "Fill the email",
  });
  const link = handoffUrlForRecord(record);
  assert.match(link, /\/handoff\//);
  const locked = isBrowserHandoffLocked(projectRoot);
  assert.equal(locked.locked, true);
  assert.equal(locked.pageUrl, tab.url);
  const during = await session.observe(tab);
  assert.match(during.snapshot, /Email/);
  const done = completeHandoff(projectRoot, record.id);
  assert.equal(done?.status, "completed");
  assert.equal(isBrowserHandoffLocked(projectRoot).locked, false);
  const after = await session.observe(tab);
  assert.match(after.snapshot, /Email/);
  console.log("handoff lock and complete: ok", link);
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
process.exit(0);
