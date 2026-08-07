/**
 * Discover Joshu app manifests from arozos/subservice/<app>/joshu.app.json
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { JoshuAppManifest } from "@joshu/app-sdk";

export type { JoshuAppManifest };

export type AppActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

const manifestCache = new Map<string, JoshuAppManifest>();
const actionHandlers = new Map<string, Map<string, AppActionHandler>>();

export function registerAppAction(appId: string, action: string, handler: AppActionHandler): void {
  if (!actionHandlers.has(appId)) actionHandlers.set(appId, new Map());
  actionHandlers.get(appId)!.set(action, handler);
}

export function getAppActionHandler(appId: string, action: string): AppActionHandler | undefined {
  return actionHandlers.get(appId)?.get(action);
}

export function hasAppActionHandler(appId: string, action: string): boolean {
  return actionHandlers.get(appId)?.has(action) ?? false;
}

export async function loadAppManifests(projectRoot: string): Promise<Map<string, JoshuAppManifest>> {
  manifestCache.clear();
  const subRoots = resolveSubserviceRoots(projectRoot);
  for (const subRoot of subRoots) {
    await scanSubserviceRoot(subRoot, manifestCache);
  }
  return manifestCache;
}

/** Dev monorepo first; runtime ArozOS volume fills gaps on VPS hotpatches. */
function resolveSubserviceRoots(projectRoot: string): string[] {
  const roots: string[] = [path.join(projectRoot, "arozos", "subservice")];
  const arozData = process.env.AROZ_DATA?.trim();
  if (arozData) roots.push(path.join(arozData, "subservice"));
  const arozTemplate = process.env.AROZ_TEMPLATE?.trim();
  if (arozTemplate) roots.push(path.join(arozTemplate, "subservice"));
  return roots;
}

async function scanSubserviceRoot(
  subRoot: string,
  cache: Map<string, JoshuAppManifest>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(subRoot);
  } catch {
    return;
  }
  for (const dir of entries) {
    const manifestPath = path.join(subRoot, dir, "joshu.app.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      const doc = JSON.parse(raw) as JoshuAppManifest;
      if (doc.id && !cache.has(doc.id)) cache.set(doc.id, doc);
    } catch {
      /* skip dirs without manifest */
    }
  }
}

export function getAppManifest(appId: string): JoshuAppManifest | undefined {
  return manifestCache.get(appId);
}

export function listAppManifests(): JoshuAppManifest[] {
  return [...manifestCache.values()];
}

export function collectAppSkillNames(): string[] {
  const names = new Set<string>();
  for (const m of manifestCache.values()) {
    if (m.agent?.skill) names.add(m.agent.skill);
  }
  return [...names];
}
