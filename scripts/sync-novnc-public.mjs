#!/usr/bin/env node
/**
 * Refresh the vendored noVNC client under public/vendor/novnc/.
 *
 * Joshu serves core/rfb.js from this tree. Camofox still owns websockify.
 *
 *   node scripts/sync-novnc-public.mjs           # copy if VERSION matches pin
 *   node scripts/sync-novnc-public.mjs --fetch   # download v1.7.0 tarball
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "1.7.0";
const TARBALL_URL = `https://github.com/novnc/noVNC/archive/refs/tags/v${PIN}.tar.gz`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dest = path.join(root, "public", "vendor", "novnc");
const doFetch = process.argv.includes("--fetch");

function fail(msg) {
  console.error(`[sync-novnc] ${msg}`);
  process.exit(1);
}

if (!doFetch) {
  const versionPath = path.join(dest, "VERSION");
  const rfbPath = path.join(dest, "core", "rfb.js");
  if (!fs.existsSync(versionPath) || !fs.existsSync(rfbPath)) {
    fail(`missing ${path.relative(root, dest)} — run with --fetch`);
  }
  const version = fs.readFileSync(versionPath, "utf8").trim();
  if (version !== PIN) fail(`VERSION ${version} != pin ${PIN} — run with --fetch`);
  console.log(`[sync-novnc] ok ${path.relative(root, dest)} ${version}`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joshu-novnc-"));
try {
  const tarPath = path.join(tmp, "novnc.tar.gz");
  execFileSync("curl", ["-fsSL", "-o", tarPath, TARBALL_URL], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", tarPath, "-C", tmp], { stdio: "inherit" });
  const src = path.join(tmp, `noVNC-${PIN}`);
  if (!fs.existsSync(path.join(src, "core", "rfb.js"))) fail("tarball missing core/rfb.js");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(src, "core"), path.join(dest, "core"), { recursive: true });
  fs.cpSync(path.join(src, "vendor"), path.join(dest, "vendor"), { recursive: true });
  fs.copyFileSync(path.join(src, "LICENSE.txt"), path.join(dest, "LICENSE.txt"));
  fs.writeFileSync(path.join(dest, "VERSION"), `${PIN}\n`);
  fs.writeFileSync(
    path.join(dest, "README.md"),
    [
      "# Vendored noVNC (Joshu)",
      "",
      `Pin: **${PIN}** (\`VERSION\`).`,
      `Upstream: https://github.com/novnc/noVNC/tree/v${PIN}`,
      "License: MPL-2.0 (`LICENSE.txt`).",
      "",
      "Joshu serves `core/rfb.js` from this tree. The WebSocket still goes to Camofox",
      "websockify (`/joshu/novnc/websockify`). Refresh with:",
      "",
      "```",
      "node scripts/sync-novnc-public.mjs --fetch",
      "```",
      "",
    ].join("\n"),
  );
  console.log(`[sync-novnc] wrote ${path.relative(root, dest)} ${PIN}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
