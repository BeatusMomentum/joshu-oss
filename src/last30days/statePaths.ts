/**
 * Persistent last30days state under the ArozOS user `.joshu/` tree
 * (`joshu_arozos` volume). Survives `joshu-stack` recreate / fleet updates.
 *
 * Layout under `{AROZ_DATA}/files/users/<user>/.joshu/last30days/`:
 *   runs/              — Joshu run JSON
 *   query-plans/       — persisted watch/research plans
 *   plan-runtime/      — one-shot plan files for `--plan`
 *   watch-snapshots.json
 *   config/            — Settings `.env` (was ~/.config/last30days)
 *   share/             — engine research.db (was ~/.local/share/last30days)
 *   memory/            — engine memory/corpus (was ~/Documents/Last30Days)
 *
 * Legacy paths (container overlay FS) are migrated once on boot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joshuConfigDir } from "../nylas/paths.js";

const STATE_SUBDIR = "last30days";

/** Prefer Aroz user `.joshu/last30days`; fall back to projectRoot for local/dev without Aroz. */
export function last30daysStateDir(projectRoot: string): string {
  const userJoshu = joshuConfigDir(projectRoot);
  if (userJoshu) {
    return path.join(userJoshu, STATE_SUBDIR);
  }
  return path.join(projectRoot, ".joshu", STATE_SUBDIR);
}

export function last30daysRunsDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "runs");
}

export function last30daysQueryPlansDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "query-plans");
}

export function last30daysPlanRuntimeDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "plan-runtime");
}

export function last30daysWatchSnapshotsPath(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "watch-snapshots.json");
}

/** Settings `.env` — was `~/.config/last30days`. */
export function last30daysConfigDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "config");
}

/** Engine SQLite store (`research.db`) — was `~/.local/share/last30days`. */
export function last30daysShareDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "share");
}

/** Engine memory/corpus — was `~/Documents/Last30Days`. */
export function last30daysMemoryDir(projectRoot: string): string {
  return path.join(last30daysStateDir(projectRoot), "memory");
}

function legacyOverlayStateDir(projectRoot: string): string {
  return path.join(projectRoot, ".joshu", STATE_SUBDIR);
}

function xdgConfigDir(): string {
  return path.join(os.homedir(), ".config", "last30days");
}

function xdgShareDir(): string {
  return path.join(os.homedir(), ".local", "share", "last30days");
}

function xdgMemoryDir(): string {
  return path.join(os.homedir(), "Documents", "Last30Days");
}

function copyFileIfMissing(src: string, dest: string): void {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* best effort */
  }
}

function copyDirMerge(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      copyDirMerge(from, to);
    } else if (st.isFile()) {
      copyFileIfMissing(from, to);
    }
  }
}

/**
 * Replace `linkPath` with a symlink to `targetDir` after contents were copied.
 * Safe once migrate has merged files into the volume path.
 */
function replaceWithSymlink(linkPath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      if (path.resolve(path.dirname(linkPath), current) === path.resolve(targetDir)) {
        return;
      }
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      /* fall through and try symlink anyway */
    }
  }
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o755 });
    fs.symlinkSync(targetDir, linkPath, "dir");
  } catch {
    /* best effort — volume path alone is enough when env/patch is set */
  }
}

/**
 * One-shot: copy legacy overlay + XDG last30days paths into the user tree when
 * destination files are missing. Safe to call on every boot / research spawn.
 */
export function migrateLegacyLast30daysState(projectRoot: string): void {
  const destRoot = last30daysStateDir(projectRoot);

  try {
    fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(last30daysConfigDir(projectRoot), { recursive: true, mode: 0o700 });
    fs.mkdirSync(last30daysShareDir(projectRoot), { recursive: true, mode: 0o700 });
    fs.mkdirSync(last30daysMemoryDir(projectRoot), { recursive: true, mode: 0o700 });

    // Legacy `/opt/joshu/.joshu/last30days` (overlay) → user tree.
    const overlayRoot = legacyOverlayStateDir(projectRoot);
    if (path.resolve(destRoot) !== path.resolve(overlayRoot) && fs.existsSync(overlayRoot)) {
      copyDirMerge(path.join(overlayRoot, "runs"), path.join(destRoot, "runs"));
      copyDirMerge(path.join(overlayRoot, "query-plans"), path.join(destRoot, "query-plans"));
      copyDirMerge(path.join(overlayRoot, "plan-runtime"), path.join(destRoot, "plan-runtime"));
      copyDirMerge(path.join(overlayRoot, "config"), last30daysConfigDir(projectRoot));
      copyDirMerge(path.join(overlayRoot, "share"), last30daysShareDir(projectRoot));
      copyDirMerge(path.join(overlayRoot, "memory"), last30daysMemoryDir(projectRoot));
      copyFileIfMissing(
        path.join(overlayRoot, "watch-snapshots.json"),
        path.join(destRoot, "watch-snapshots.json"),
      );
    }

    // Classic XDG homes (also overlay under /root) → user tree, then redirect.
    const xdgCfg = xdgConfigDir();
    const xdgShare = xdgShareDir();
    const xdgMem = xdgMemoryDir();
    const cfgDest = last30daysConfigDir(projectRoot);
    const shareDest = last30daysShareDir(projectRoot);
    const memDest = last30daysMemoryDir(projectRoot);

    if (path.resolve(xdgCfg) !== path.resolve(cfgDest)) {
      copyDirMerge(xdgCfg, cfgDest);
      replaceWithSymlink(xdgCfg, cfgDest);
    }
    if (path.resolve(xdgShare) !== path.resolve(shareDest)) {
      copyDirMerge(xdgShare, shareDest);
      replaceWithSymlink(xdgShare, shareDest);
    }
    if (path.resolve(xdgMem) !== path.resolve(memDest)) {
      copyDirMerge(xdgMem, memDest);
      replaceWithSymlink(xdgMem, memDest);
    }
  } catch (err) {
    console.warn(
      "[last30days] legacy state migrate skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}
