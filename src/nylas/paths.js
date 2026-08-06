import path from "node:path";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
function envTrim(name) {
    return (process.env[name] || "").trim();
}
/**
 * Per-user Joshu config under ArozOS (Nylas grants, agent profile, identity.json).
 *
 * Prefers resolveJoshuFilesPaths (Desktop present). On first VPS boot the Aroz
 * user / Desktop may not exist yet — fall back to JOSHU_AROZ_USER so companion
 * identity (tray avatar) can still be written under `.joshu/`.
 */
export function joshuConfigDir(projectRoot = process.cwd()) {
    const paths = resolveJoshuFilesPaths(projectRoot);
    if (paths) {
        return path.join(paths.arozData, "files", "users", paths.arozUser, ".joshu");
    }
    const arozUser = envTrim("JOSHU_AROZ_USER") || envTrim("JOSHU_OWNER_EMAIL");
    if (!arozUser)
        return null;
    const arozData = path.resolve(envTrim("AROZ_DATA") || path.join(projectRoot, ".local", "arozos-data"));
    return path.join(arozData, "files", "users", arozUser, ".joshu");
}
//# sourceMappingURL=paths.js.map