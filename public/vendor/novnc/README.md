# Vendored noVNC (Joshu)

Pin: **1.7.0** (`VERSION`).
Upstream: https://github.com/novnc/noVNC/tree/v1.7.0
License: MPL-2.0 (`LICENSE.txt`).

Joshu serves `core/rfb.js` from this tree. The WebSocket still goes to Camofox
websockify (`/joshu/novnc/websockify`). Refresh with:

```
node scripts/sync-novnc-public.mjs --fetch
```
