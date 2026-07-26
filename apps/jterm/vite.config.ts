import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: appRoot,
  build: {
    outDir: "../../dist/jterm",
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8799",
        ws: true,
      },
    },
  },
});
