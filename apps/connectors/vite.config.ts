import react from "@vitejs/plugin-react";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const outDir = path.resolve(repoRoot, "dist/connectors-app");

/** After each build (including --watch), copy into local ArozOS so the desktop app picks up changes without a full stack rebuild. */
function syncConnectorsToArozos(): Plugin {
  const targets = [
    path.join(repoRoot, ".local/arozos-data/subservice/connectors/app"),
    path.join(repoRoot, ".local/arozos-template-source/subservice/connectors/app"),
  ];

  const sync = () => {
    if (!existsSync(outDir)) return;
    for (const target of targets) {
      mkdirSync(target, { recursive: true });
      cpSync(outDir, target, { recursive: true });
    }
    console.log(
      `[connectors] synced → .local/arozos-data (and template) — refresh the Connectors window`,
    );
  };

  return {
    name: "joshu-sync-connectors-arozos",
    closeBundle: sync,
  };
}

export default defineConfig({
  base: "./",
  root: appRoot,
  server: {
    proxy: {
      // API + static under /joshu while HMR runs on :3009
      "/joshu": "http://127.0.0.1:8788",
    },
  },
  build: {
    // Must not use dist/connectors — tsc emits API modules there (routes.js, etc.).
    outDir,
    emptyOutDir: true,
  },
  plugins: [react(), syncConnectorsToArozos()],
});
