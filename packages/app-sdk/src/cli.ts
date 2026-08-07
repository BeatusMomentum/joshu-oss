#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateJoshuAppManifest, validateMultimodalProfile } from "./validateManifest.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const multimodal = args.includes("--multimodal");
  const filtered = args.filter((a) => a !== "--multimodal");
  const cmd = filtered[0] ?? "validate";
  if (cmd !== "validate") {
    console.error(`Unknown command: ${cmd}\nUsage: joshu-app validate [--multimodal] <path/to/joshu.app.json>`);
    process.exit(2);
  }
  const manifestPath = path.resolve(filtered[1] ?? "joshu.app.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = validateJoshuAppManifest(raw);
  if (!result.ok) {
    console.error(`Invalid manifest: ${manifestPath}`);
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  if (multimodal && result.manifest) {
    const mm = validateMultimodalProfile(result.manifest);
    if (!mm.ok) {
      console.error(`Multimodal profile failed: ${manifestPath}`);
      for (const err of mm.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(`OK multimodal ${manifestPath} (${result.manifest.id}@${result.manifest.version})`);
    return;
  }
  console.log(`OK ${manifestPath} (${result.manifest!.id}@${result.manifest!.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
