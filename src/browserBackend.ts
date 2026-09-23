/**
 * Shared browser backend: local headed Chromium (CDP + optional noVNC) vs Browser Use Cloud.
 *
 * Precedence (user toggle wins over fleet provision):
 * 1. `.joshu/safety-settings/local-env.json` — Safety Settings UI
 * 2. `/etc/joshu/instance.env` / process.env — operator provision (`JOSHU_CLOUD_BROWSER`)
 * 3. Default: **local** (OSS self-host without browser-use.com)
 */
import { provisionEnvTrim } from "./provisionInstanceEnv.js";
import { readLocalEnvOverrides } from "./safetySettings/localEnv.js";

export type BrowserBackend = "local" | "cloud";

export type BrowserBackendSource = "local-env" | "env" | "default";

function parseTruthy(value: string): boolean {
  return /^(1|true|yes)$/i.test(value.trim());
}

/** Resolve backend from Safety Settings, then instance.env, then default local. */
export function resolveBrowserBackend(projectRoot = process.cwd()): BrowserBackend {
  const local = readLocalEnvOverrides(projectRoot);
  const localBackend = (local.JOSHU_BROWSER_BACKEND || "").trim().toLowerCase();
  if (localBackend === "local" || localBackend === "chromium") return "local";
  if (localBackend === "cloud") return "cloud";
  if (local.JOSHU_CLOUD_BROWSER?.trim()) {
    return parseTruthy(local.JOSHU_CLOUD_BROWSER) ? "cloud" : "local";
  }

  const provision = provisionEnvTrim("JOSHU_CLOUD_BROWSER") || process.env.JOSHU_CLOUD_BROWSER?.trim() || "";
  if (provision) return parseTruthy(provision) ? "cloud" : "local";
  return "local";
}

export function browserBackendSource(projectRoot = process.cwd()): BrowserBackendSource {
  const local = readLocalEnvOverrides(projectRoot);
  if (local.JOSHU_BROWSER_BACKEND?.trim() || local.JOSHU_CLOUD_BROWSER?.trim()) return "local-env";
  if (provisionEnvTrim("JOSHU_CLOUD_BROWSER") || process.env.JOSHU_CLOUD_BROWSER?.trim()) return "env";
  return "default";
}

export function cloudBrowserEnabled(projectRoot = process.cwd()): boolean {
  return resolveBrowserBackend(projectRoot) === "cloud";
}
