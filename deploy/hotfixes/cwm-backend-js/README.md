# Compiled from `src/excalidraw/*.ts`.

Fallback for host `dist/excalidraw/` when a pulled image is missing `errors.js`
(0.1.41 Vite `emptyOutDir` wiped tsc output). Rebuilt `0.1.41` GHCR tags include
these files; `scripts/sync-dist-from-image.sh` copies this directory only if
`docker cp` still lacks `errors.js`.
