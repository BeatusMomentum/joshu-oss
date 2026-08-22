import path from "node:path";
import { CwmInputError } from "./errors.js";
function isInsideRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Resolve only relative .excalidraw boards and derive their exact sibling sidecars. */
export function resolveCwmBoardPaths(filesRoot, requestedPath) {
    if (typeof requestedPath !== "string" || requestedPath.length === 0) {
        throw new CwmInputError("path is required");
    }
    if (requestedPath !== requestedPath.trim() || requestedPath.includes("\0")) {
        throw new CwmInputError("path must be a clean relative .excalidraw path");
    }
    // Treat backslashes as separators before validation so Windows-style traversal cannot
    // become a harmless-looking filename on Unix and later change meaning elsewhere.
    const portablePath = requestedPath.replace(/\\/g, "/");
    if (portablePath.startsWith("/") ||
        /^[A-Za-z]:\//.test(portablePath) ||
        portablePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new CwmInputError("path must stay within joshu's files");
    }
    if (!portablePath.endsWith(".excalidraw")) {
        throw new CwmInputError("path must reference a .excalidraw board");
    }
    const root = path.resolve(filesRoot);
    const boardPath = path.resolve(root, ...portablePath.split("/"));
    if (!isInsideRoot(root, boardPath) || boardPath === root) {
        throw new CwmInputError("path must stay within joshu's files");
    }
    return {
        filesRoot: root,
        relativePath: portablePath,
        boardPath,
        workspacePath: `${boardPath}.cwm.json`,
        eventsPath: `${boardPath}.cwm.events.jsonl`,
    };
}
/** Consolidation artifacts have one fixed directory and accept only a plain Markdown basename. */
export function resolveCwmHandoffPath(filesRoot, fileName) {
    if (!fileName ||
        fileName !== fileName.trim() ||
        fileName.includes("\0") ||
        fileName.includes("/") ||
        fileName.includes("\\") ||
        fileName === "." ||
        fileName === ".." ||
        !fileName.toLowerCase().endsWith(".md")) {
        throw new CwmInputError("fileName must be a plain .md filename");
    }
    const root = path.resolve(filesRoot);
    const relativePath = path.posix.join("Planning", "cwm-sessions", fileName);
    const absolutePath = path.resolve(root, "Planning", "cwm-sessions", fileName);
    if (!isInsideRoot(root, absolutePath)) {
        throw new CwmInputError("handoff path must stay within Planning/cwm-sessions");
    }
    return { relativePath, absolutePath };
}
export function defaultCwmHandoffFileName(occurredAt, eventId) {
    const timestamp = occurredAt.replace(/[:.]/g, "-");
    const safeId = eventId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
    return `cwm-session-${timestamp}-${safeId}.md`;
}
//# sourceMappingURL=paths.js.map