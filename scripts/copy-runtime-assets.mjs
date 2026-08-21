#!/usr/bin/env node
/**
 * Copy / verify non-TS files the Joshu API reads at runtime.
 *
 * Laptop `tsx` can see `apps/` and `src/`. The VPS only sees `dist/` (compose
 * bind-mount) plus explicit Dockerfile COPYs. tsc emits .js only — HTML/PNG
 * and similar must be listed in runtime-assets.json and copied here.
 *
 *   node scripts/copy-runtime-assets.mjs                  # copy src → dest
 *   node scripts/copy-runtime-assets.mjs --check-source   # src exists
 *   node scripts/copy-runtime-assets.mjs --check          # dest exists (post-build)
 *   node scripts/copy-runtime-assets.mjs --check-source --check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(__dirname, "runtime-assets.json");

const args = new Set(process.argv.slice(2));
const doCheckDest = args.has("--check");
const doCheckSource = args.has("--check-source");
const doCopy = !doCheckDest && !doCheckSource;

function fail(msg) {
  console.error(`[runtime-assets] ${msg}`);
  process.exit(1);
}

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    fail(`missing ${path.relative(root, manifestPath)}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assets = Array.isArray(raw?.assets) ? raw.assets : [];
  if (assets.length === 0) fail("runtime-assets.json has no assets[]");
  return assets;
}

/** dest must stay inside dist/ so we never copy into source trees. */
function assertDestSafe(destRel) {
  const normalized = destRel.replaceAll("\\", "/");
  if (!normalized.startsWith("dist/") || normalized.includes("..")) {
    fail(`unsafe dest "${destRel}" — must be under dist/ with no ..`);
  }
}

function rel(p) {
  return path.relative(root, p);
}

const assets = loadManifest();
let copied = 0;

for (const asset of assets) {
  const srcRel = String(asset?.src || "").trim();
  const destRel = String(asset?.dest || "").trim();
  const reason = String(asset?.reason || srcRel);
  const contains = Array.isArray(asset?.contains) ? asset.contains.map(String) : [];
  if (!srcRel || !destRel) fail(`asset missing src/dest (${reason})`);
  assertDestSafe(destRel);

  const src = path.join(root, srcRel);
  const dest = path.join(root, destRel);

  if (doCopy || doCheckSource) {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      fail(`source missing: ${srcRel} (${reason})`);
    }
  }

  if (doCopy) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied += 1;
  }

  if (doCheckDest) {
    if (!fs.existsSync(dest) || !fs.statSync(dest).isFile()) {
      fail(
        `dest missing: ${destRel} (${reason}). Run npm run build — it copies runtime-assets.json into dist/.`,
      );
    }
    if (fs.statSync(dest).size < 1) fail(`dest empty: ${destRel} (${reason})`);
  }

  const inspectPath = doCopy || doCheckDest ? dest : src;
  if (contains.length > 0 && fs.existsSync(inspectPath)) {
    const body = fs.readFileSync(inspectPath, "utf8");
    for (const needle of contains) {
      if (!body.includes(needle)) {
        fail(`${rel(inspectPath)} missing required string ${JSON.stringify(needle)} (${reason})`);
      }
    }
  }
}

if (doCopy) {
  console.log(`[runtime-assets] copied ${copied} file(s) into dist/`);
} else {
  const bits = [];
  if (doCheckSource) bits.push("source");
  if (doCheckDest) bits.push("dest");
  console.log(`[runtime-assets] ok (${bits.join("+") || "nop"}; ${assets.length} listed)`);
}
