import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: appRoot,
  server: {
    proxy: {
      "/joshu": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: "../../dist/last30days-app",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@joshu/app-agent": path.resolve(appRoot, "../../packages/app-agent/src"),
      "@joshu/jchat-ui": path.resolve(appRoot, "../../packages/jchat-ui/src"),
      "@joshu/last30days-format": path.resolve(appRoot, "../../src/last30days/agentReportFormat.ts"),
    },
  },
  plugins: [react()],
});
