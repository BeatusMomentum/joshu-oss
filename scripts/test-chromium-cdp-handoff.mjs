#!/usr/bin/env npx tsx
/**
 * Proves the CDP handoff path without Camofox:
 * - Hermes browser_tool.py gains a lock on navigate/click/type/press/back, not snapshot
 * - Playwright connectOverCDP can scan and fill the shared page
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { ChromiumCdpSession } from "../src/chromiumSession.ts";

const root = process.cwd();
const hermesTool = process.env.HERMES_BROWSER_TOOL
  || "/Users/danbenyamin/Documents/dev/hermes-agent/tools/browser_tool.py";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-cdp-patch-"));
const patched = path.join(tmp, "browser_tool.py");
fs.copyFileSync(hermesTool, patched);
execFileSync("node", [path.join(root, "scripts/patch-hermes-browser-cdp-guards.mjs"), patched], {
  stdio: "inherit",
});
const source = fs.readFileSync(patched, "utf8");

function fnBody(name) {
  const start = source.indexOf(`def ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("\ndef ", start + 1);
  return source.slice(start, next > start ? next : undefined);
}

for (const name of ["browser_navigate", "browser_click", "browser_type", "browser_press", "browser_back"]) {
  const body = fnBody(name);
  const ret = body.indexOf("return camofox_");
  const lock = body.indexOf("_joshu_browser_handoff_lock_check()");
  assert.ok(ret >= 0 && lock > ret, `${name} lock must follow the Camofox return`);
}
assert.equal(fnBody("browser_snapshot").includes("_joshu_browser_handoff_lock_check()"), false);
for (const name of ["browser_click", "browser_type", "browser_press"]) {
  assert.match(fnBody(name), /_joshu_action_guard_browser/);
}
assert.equal(fnBody("browser_navigate").includes("_joshu_action_guard_browser"), false);
console.log("cdp guard patch: ok");

const chrome = process.env.CHROMIUM_BIN
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(chrome)) {
  console.log("cdp form fill: skipped (no Chrome at " + chrome + ")");
  process.exit(0);
}

const cdpPort = 9333;
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const session = new ChromiumCdpSession({
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    controlUrl: "http://127.0.0.1:9",
    sessionKey: "hitl-main",
    singleTab: true,
    viewportWidth: 1024,
    viewportHeight: 768,
  });
  const html = `<!doctype html><form>
    <label>Email <input id="email" name="email" type="email" placeholder="Email"></label>
    <button type="submit">Continue</button>
  </form>`;
  const tab = await session.ensureTab(`data:text/html,${encodeURIComponent(html)}`, { navigateExisting: true });
  assert.ok(tab.url.startsWith("data:text/html"), tab.url);
  const catalog = await session.listFormFields();
  assert.ok(catalog.fields.some((field) => field.type === "email"), JSON.stringify(catalog.fields));
  assert.ok(catalog.buttons.some((button) => /continue/i.test(button.text)), JSON.stringify(catalog.buttons));
  const email = catalog.fields.find((field) => field.type === "email");
  const filled = await session.fillForm({
    fields: [{ id: email.id, value: "owner@example.com" }],
    buttonId: null,
  });
  assert.equal(filled.ok, true, JSON.stringify(filled));
  assert.equal(filled.filled, 1);
  const signature = await session.readFormSignature();
  assert.match(signature.key, /email/i);
  const check = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const page = check.contexts()[0]?.pages()[0];
  assert.ok(page, "shared page missing");
  const value = await page.locator("#email").inputValue();
  assert.equal(value, "owner@example.com");
  console.log("cdp form fill: ok");
} finally {
  await browser.close();
}
