/**
 * Disk cache for Composio toolkit listings — stale-while-revalidate for Connectors UI.
 */
import fs from "node:fs";
import path from "node:path";
import type { ComposioToolkitRow } from "../../composioApi.js";
import { joshuConfigDir } from "../../nylas/paths.js";

export type ToolkitsCacheEntry = {
  toolkits: ComposioToolkitRow[];
  cursor?: string;
  fetchedAt: string;
};

type ToolkitsCacheFile = {
  featured?: ToolkitsCacheEntry;
  bySearch?: Record<string, ToolkitsCacheEntry>;
};

const FEATURED_STALE_MS = 60 * 60 * 1000;
const SEARCH_STALE_MS = 15 * 60 * 1000;

const refreshInFlight = new Map<string, Promise<void>>();

function cachePath(projectRoot: string): string | null {
  const dir = joshuConfigDir(projectRoot);
  if (!dir) return null;
  return path.join(dir, "composio-toolkits-cache.json");
}

function readCacheFile(projectRoot: string): ToolkitsCacheFile {
  const file = cachePath(projectRoot);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ToolkitsCacheFile;
  } catch {
    return {};
  }
}

function writeCacheFile(projectRoot: string, data: ToolkitsCacheFile): void {
  const file = cachePath(projectRoot);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function cacheKey(search: string): string {
  return search.trim().toLowerCase();
}

function entryAgeMs(entry: ToolkitsCacheEntry): number {
  const ms = Date.parse(entry.fetchedAt);
  return Number.isFinite(ms) ? Date.now() - ms : Number.POSITIVE_INFINITY;
}

export function readToolkitsCache(
  projectRoot: string,
  search = "",
): ToolkitsCacheEntry | null {
  const key = cacheKey(search);
  const file = readCacheFile(projectRoot);
  if (!key) return file.featured ?? null;
  return file.bySearch?.[key] ?? null;
}

/** Drop cached toolkit listings (connection state is reconciled live on read). */
export function clearToolkitsCache(projectRoot: string): void {
  const file = cachePath(projectRoot);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

export function writeToolkitsCache(
  projectRoot: string,
  search: string,
  entry: Omit<ToolkitsCacheEntry, "fetchedAt"> & { fetchedAt?: string },
): ToolkitsCacheEntry {
  const key = cacheKey(search);
  const stored: ToolkitsCacheEntry = {
    toolkits: entry.toolkits,
    cursor: entry.cursor,
    fetchedAt: entry.fetchedAt ?? new Date().toISOString(),
  };
  const file = readCacheFile(projectRoot);
  if (!key) {
    file.featured = stored;
  } else {
    file.bySearch = file.bySearch ?? {};
    file.bySearch[key] = stored;
  }
  writeCacheFile(projectRoot, file);
  return stored;
}

export function isToolkitsCacheStale(search: string, entry: ToolkitsCacheEntry): boolean {
  const maxAge = cacheKey(search) ? SEARCH_STALE_MS : FEATURED_STALE_MS;
  return entryAgeMs(entry) > maxAge;
}

/** Refresh cache in background; dedupe concurrent refreshes per search key. */
export function scheduleToolkitsCacheRefresh(
  projectRoot: string,
  search: string,
  refresh: () => Promise<{ toolkits: ComposioToolkitRow[]; cursor?: string }>,
): void {
  const key = cacheKey(search) || "__featured__";
  if (refreshInFlight.has(key)) return;
  const job = refresh()
    .then((result) => {
      writeToolkitsCache(projectRoot, search, result);
    })
    .catch((err) => {
      console.warn(
        `[composio-toolkits-cache] refresh failed (${key}):`,
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      refreshInFlight.delete(key);
    });
  refreshInFlight.set(key, job);
}
