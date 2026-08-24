import type { MutableRefObject } from "react";
import type { JoshuGuiActionInput } from "@joshu/app-agent";

export type MdEditorGuiAgentApi = {
  getGuiSnapshot: () => Record<string, unknown>;
  getDocument: () => { markdown: string; path: string | null; dirty: boolean; filename: string };
  replaceDocument: (markdown: string) => void;
  insertMarkdown: (markdown: string, inline?: boolean) => void;
  appendMarkdown: (markdown: string) => void;
  saveDocument: (path?: string) => Promise<string>;
  newDocument: () => void;
  openFile: (path: string) => Promise<string>;
};

/** GUI action handlers for the embedded agent (names match manifest guiActions[]). */
export function createMdEditorGuiActions(
  guiRef: MutableRefObject<MdEditorGuiAgentApi | null>,
): JoshuGuiActionInput[] {
  return [
    {
      name: "replaceDocument",
      description: "Replace the entire open markdown document",
      parameters: [{ name: "markdown", type: "string", required: true }],
      handler: async (args) => {
        guiRef.current?.replaceDocument(String(args.markdown ?? ""));
        return "Document replaced in the editor. User can still edit or save.";
      },
    },
    {
      name: "insertMarkdown",
      description: "Insert markdown at the cursor",
      parameters: [
        { name: "markdown", type: "string", required: true },
        { name: "inline", type: "boolean" },
      ],
      handler: async (args) => {
        guiRef.current?.insertMarkdown(String(args.markdown ?? ""), Boolean(args.inline));
        return "Markdown inserted.";
      },
    },
    {
      name: "appendMarkdown",
      description: "Append markdown to the end of the document",
      parameters: [{ name: "markdown", type: "string", required: true }],
      handler: async (args) => {
        guiRef.current?.appendMarkdown(String(args.markdown ?? ""));
        return "Markdown appended.";
      },
    },
    {
      name: "getDocument",
      description: "Return current markdown and path",
      handler: async () => {
        const doc = guiRef.current?.getDocument();
        if (!doc) return "Editor not ready.";
        const preview =
          doc.markdown.length > 12000
            ? `${doc.markdown.slice(0, 12000)}\n\n…[truncated ${doc.markdown.length - 12000} chars]`
            : doc.markdown;
        return JSON.stringify({
          path: doc.path,
          filename: doc.filename,
          dirty: doc.dirty,
          markdown: preview,
          length: doc.markdown.length,
        });
      },
    },
    {
      name: "saveDocument",
      description: "Save the open document; provide a path for an untitled note",
      parameters: [
        {
          name: "path",
          type: "string",
          description: "Optional path relative to joshu's files (required for an untitled note)",
        },
      ],
      handler: async (args) => {
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        const result = await guiRef.current?.saveDocument(path);
        return result ?? "Save failed — editor not ready.";
      },
    },
    {
      name: "newDocument",
      description: "Clear the editor to a blank untitled note",
      handler: async () => {
        guiRef.current?.newDocument();
        return "Blank note opened (unsaved).";
      },
    },
    {
      name: "openFile",
      description: "Open a markdown file under joshu's files",
      parameters: [{ name: "path", type: "string", required: true }],
      handler: async (args) => {
        const result = await guiRef.current?.openFile(String(args.path ?? ""));
        return result ?? "Open failed — editor not ready.";
      },
    },
  ];
}
