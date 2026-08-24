import type { FilesContext, OpenTarget } from "./fileOpen.js";
import { resolveFilesApiBase } from "./fileOpen.js";

export async function fetchFilesContext(): Promise<FilesContext | null> {
  try {
    const res = await fetch(`${resolveFilesApiBase()}/context`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      joshuFilesDirName?: string;
      arozPathPrefix?: string;
      arozDesktopPrefix?: string;
    };
    if (!body.joshuFilesDirName || !body.arozPathPrefix) return null;
    return {
      joshuFilesDirName: body.joshuFilesDirName,
      arozPathPrefix: body.arozPathPrefix,
      arozDesktopPrefix: body.arozDesktopPrefix ?? "user:/Desktop",
    };
  } catch {
    return null;
  }
}

/** Prefer ArozOS /media for virtual desktop paths; fall back to Joshu files API. */
export async function readMarkdown(target: OpenTarget): Promise<string> {
  if (target.arozFilepath) {
    const mediaUrl = `/media?file=${encodeURIComponent(target.arozFilepath)}&_=${Date.now()}`;
    const mediaRes = await fetch(mediaUrl, { cache: "no-store" });
    if (mediaRes.ok) {
      const text = await mediaRes.text();
      // ArozOS sometimes returns JSON error bodies with HTTP 200.
      const trimmed = text.trimStart();
      if (trimmed.startsWith("{") && trimmed.includes('"error"')) {
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (typeof parsed.error === "string" && parsed.error) {
            throw new Error(parsed.error);
          }
        } catch (err) {
          if (err instanceof Error && !(err instanceof SyntaxError)) throw err;
        }
      }
      return text;
    }
  }

  const qs = new URLSearchParams({
    path: target.relativePath,
    root: target.root,
  });
  const res = await fetch(`${resolveFilesApiBase()}/read?${qs}`, { cache: "no-store" });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `${res.status} ${res.statusText}`);
  }
  return res.text();
}

export async function writeMarkdown(target: OpenTarget, content: string): Promise<void> {
  const res = await fetch(`${resolveFilesApiBase()}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: target.relativePath,
      root: target.root,
      content,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `${res.status} ${res.statusText}`);
  }
}
