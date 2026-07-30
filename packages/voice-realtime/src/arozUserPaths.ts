/**
 * Box-local Aroz user paths.
 *
 * voice-realtime reads owner-facing state — Telephone settings, pre-rendered
 * voice clips — out of the single non-admin Aroz user's `.joshu/` directory,
 * the same place the desktop apps write it.
 */
import fs from "node:fs";
import path from "node:path";

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Aroz data root; matches AROZ_DATA in the sandbox image. */
export function arozDataRoot(): string {
  return envTrim("AROZ_DATA") || "/var/lib/arozos";
}

/**
 * The owner's Aroz username: JOSHU_AROZ_USER when set, else the first
 * non-admin user that has a Desktop, else any user with a Desktop.
 */
export function pickArozUser(usersRoot: string): string | null {
  const overrideUser = envTrim("JOSHU_AROZ_USER");
  if (overrideUser) {
    const desktop = path.join(usersRoot, overrideUser, "Desktop");
    return fs.existsSync(desktop) ? overrideUser : null;
  }
  try {
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === "admin") continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
    for (const ent of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (fs.existsSync(path.join(usersRoot, ent.name, "Desktop"))) return ent.name;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Absolute path under the owner's `.joshu/` directory, or null when the box has
 * no Aroz user yet (fresh image, first boot).
 */
export function joshuUserPath(...segments: string[]): string | null {
  const usersRoot = path.join(arozDataRoot(), "files", "users");
  if (!fs.existsSync(usersRoot)) return null;
  const user = pickArozUser(usersRoot);
  if (!user) return null;
  return path.join(usersRoot, user, ".joshu", ...segments);
}
