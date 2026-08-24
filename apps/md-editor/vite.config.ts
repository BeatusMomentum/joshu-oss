import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const platformDataRoot = path.resolve(appRoot, "../../packages/platform-data/src/index.ts");
const appAgentRoot = path.resolve(appRoot, "../../packages/app-agent/src");
const jchatUiRoot = path.resolve(appRoot, "../../packages/jchat-ui/src");

export default defineConfig({
  base: "./",
  root: appRoot,
  build: {
    outDir: "../../dist/md-editor",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@joshu/platform-data": platformDataRoot,
      "@joshu/app-agent": appAgentRoot,
      "@joshu/jchat-ui": jchatUiRoot,
    },
  },
  plugins: [react()],
  server: {
    proxy: {
      "/joshu/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
