/**
 * Path helpers for ArozOS file-open hashes and Joshu files API.
 * Mirrors jWhiteboard's hash parsing so double-click .md works the same way.
 */

export type FilesContext = {
  joshuFilesDirName: string;
  arozPathPrefix: string;
  arozDesktopPrefix?: string;
};

export type OpenTarget = {
  /** Relative path for Joshu /api/files (under files or desktop root). */
  relativePath: string;
  /** "files" = under joshu's files; "desktop" = anywhere on Desktop. */
  root: "files" | "desktop";
  filename: string;
  /** Original ArozOS filepath when opened via Files (user:/Desktop/...). */
  arozFilepath?: string;
};

export type ArozOpenFile = {
  filepath: string;
  filename: string;
};

function tryDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse ArozOS #[{filepath, filename}] — mirrors ao_module_loadInputFiles(). */
export function loadArozInputFiles(): ArozOpenFile[] | null {
  try {
    if (window.location.hash.length === 0) return null;
    const inputFileInfo = window.location.hash.substring(1);
    const candidates = [
      inputFileInfo,
      tryDecodeURIComponent(inputFileInfo),
      tryDecodeURIComponent(tryDecodeURIComponent(inputFileInfo) ?? ""),
    ].filter((v): v is string => typeof v === "string" && v.length > 0);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        const out: ArozOpenFile[] = [];
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const filepath = (entry as { filepath?: unknown }).filepath;
          const filename = (entry as { filename?: unknown }).filename;
          if (typeof filepath === "string" && filepath.trim()) {
            out.push({
              filepath: filepath.trim(),
              filename: typeof filename === "string" && filename.trim() ? filename.trim() : filepath.split("/").pop() ?? "note.md",
            });
          }
        }
        if (out.length > 0) return out;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Map user:/Desktop/... to a Joshu files/desktop relative path. */
export function openTargetFromArozFilepath(
  arozFilepath: string,
  filenameHint: string | undefined,
  ctx: FilesContext | null,
): OpenTarget | null {
  const cleaned = arozFilepath.trim();
  if (!cleaned.startsWith("user:/")) return null;

  const withoutScheme = cleaned.slice("user:/".length).replace(/^\/+/, "");
  // Expect Desktop/... or Desktop/joshu's files/...
  const desktopPrefix = "Desktop/";
  if (!withoutScheme.startsWith(desktopPrefix) && withoutScheme !== "Desktop") {
    return null;
  }

  const underDesktop = withoutScheme === "Desktop" ? "" : withoutScheme.slice(desktopPrefix.length);
  const filename = filenameHint || underDesktop.split("/").pop() || "note.md";
  const dirName = ctx?.joshuFilesDirName ?? "joshu's files";

  if (underDesktop === dirName || underDesktop.startsWith(`${dirName}/`)) {
    const relativePath =
      underDesktop === dirName ? "" : underDesktop.slice(dirName.length + 1);
    if (!relativePath) return null;
    return {
      relativePath,
      root: "files",
      filename,
      arozFilepath: cleaned,
    };
  }

  if (!underDesktop) return null;
  return {
    relativePath: underDesktop,
    root: "desktop",
    filename,
    arozFilepath: cleaned,
  };
}

/** ?file=, #file=, or ArozOS desktop open hash. */
export function resolveOpenTargetFromLocation(ctx: FilesContext | null): OpenTarget | null {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("file") ?? params.get("path");
  if (fromQuery) {
    const clean = decodeURIComponent(fromQuery).replace(/^\/+/, "");
    const root = params.get("root") === "desktop" ? "desktop" : "files";
    return {
      relativePath: clean,
      root,
      filename: clean.split("/").pop() ?? clean,
    };
  }

  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;

  if (hash.startsWith("file=")) {
    const clean = decodeURIComponent(hash.slice("file=".length)).replace(/^\/+/, "");
    return {
      relativePath: clean,
      root: "files",
      filename: clean.split("/").pop() ?? clean,
    };
  }

  const hashParams = new URLSearchParams(hash);
  const fromHashParams = hashParams.get("file") ?? hashParams.get("path");
  if (fromHashParams) {
    const clean = decodeURIComponent(fromHashParams).replace(/^\/+/, "");
    const root = hashParams.get("root") === "desktop" ? "desktop" : "files";
    return {
      relativePath: clean,
      root,
      filename: clean.split("/").pop() ?? clean,
    };
  }

  const aroz = loadArozInputFiles();
  if (aroz?.[0]) {
    return openTargetFromArozFilepath(aroz[0].filepath, aroz[0].filename, ctx);
  }

  return null;
}

/** Joshu files API base — map ArozOS :8787 → Joshu :8788. */
export function resolveFilesApiBase(): string {
  const override = (import.meta.env.VITE_JOSHU_FILES_API_BASE as string | undefined)?.trim();
  if (override) return override.replace(/\/+$/, "");

  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    if (port === "8787") {
      return `${protocol}//${hostname}:8788/joshu/api/files`;
    }
  }
  return "/joshu/api/files";
}
