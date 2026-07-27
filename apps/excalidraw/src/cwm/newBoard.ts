const EXCALIDRAW_SUFFIX = /\.excalidraw$/i;
const PORTABLE_FILENAME_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/;

/** Convert a human board name into the durable default location. */
export function newBoardPathFromName(rawName: string): string {
  const name = rawName.trim().replace(EXCALIDRAW_SUFFIX, "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    name.length > 120 ||
    PORTABLE_FILENAME_FORBIDDEN.test(name)
  ) {
    throw new Error(
      "Use a board name of 1–120 characters without slashes or filename punctuation.",
    );
  }
  return `Planning/${name}.excalidraw`;
}
