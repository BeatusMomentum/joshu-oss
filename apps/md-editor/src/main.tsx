/**
 * jNotes — Milkdown Crepe WYSIWYG markdown editor with embedded Hermes agent.
 */

import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "@joshu/jchat-ui/jchatBubble.css";
import "@joshu/jchat-ui/jchatShell.css";
import "@joshu/jchat-ui/jchatThread.css";
import "@joshu/app-agent/agentChat.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppAgentChatSession } from "@joshu/app-agent";
import {
  Check,
  CircleAlert,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
  PenLine,
  Save,
  X,
} from "lucide-react";

import { MilkdownEditor, type MilkdownEditorHandle } from "./MilkdownEditor.js";
import { MdEditorAgentBridge, type MdEditorGuiAgentApi } from "./mdEditorAgentBridge.js";
import {
  resolveOpenTargetFromLocation,
  type FilesContext,
  type OpenTarget,
} from "./fileOpen.js";
import { fetchFilesContext, readMarkdown, writeMarkdown } from "./filesClient.js";

const SNAPSHOT_MARKDOWN_CAP = 16_000;
const EMPTY_DOCUMENT = "# Untitled\n\n";

type Toast = {
  kind: "success" | "error" | "info";
  message: string;
};

type PathDialogMode = "open" | "save";

function normalizeMarkdownPath(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) {
    throw new Error("Enter a path inside joshu's files.");
  }
  if (!/\.(md|markdown|mdx|txt)$/i.test(clean)) return `${clean}.md`;
  return clean;
}

function PathDialog({
  mode,
  initialValue,
  busy,
  onClose,
  onSubmit,
}: {
  mode: PathDialogMode;
  initialValue: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (path: string) => unknown | Promise<unknown>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [validation, setValidation] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const path = normalizeMarkdownPath(value);
      setValidation("");
      void onSubmit(path);
    } catch (err) {
      setValidation(err instanceof Error ? err.message : "Enter a valid path.");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="path-dialog"
      aria-labelledby="path-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      <form className="path-dialog-card" onSubmit={submit}>
        <div className="dialog-header">
          <div>
            <p className="dialog-kicker">joshu&apos;s files</p>
            <h2 id="path-dialog-title">{mode === "save" ? "Save note" : "Open note"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close">
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <label className="field-label" htmlFor="note-path">
          File path
        </label>
        <div className="path-input-wrap">
          <span aria-hidden="true">joshu&apos;s files /</span>
          <input
            id="note-path"
            autoFocus
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setValidation("");
            }}
            placeholder="Notes/my-note.md"
            aria-invalid={Boolean(validation)}
            aria-describedby={validation ? "path-error" : "path-help"}
          />
        </div>
        {validation ? (
          <p className="field-message field-error" id="path-error">
            <CircleAlert aria-hidden="true" size={15} />
            {validation}
          </p>
        ) : (
          <p className="field-message" id="path-help">
            {mode === "save"
              ? "Folders are created automatically. Markdown is added when no extension is provided."
              : "Enter a path relative to joshu's files."}
          </p>
        )}

        <div className="dialog-actions">
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button button-primary" type="submit" disabled={busy || !value.trim()}>
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : null}
            {mode === "save" ? "Save note" : "Open note"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function App() {
  const editorRef = useRef<MilkdownEditorHandle | null>(null);
  const guiRef = useRef<MdEditorGuiAgentApi | null>(null);

  const [filesCtx, setFilesCtx] = useState<FilesContext | null>(null);
  const [target, setTarget] = useState<OpenTarget | null>(null);
  const [documentKey, setDocumentKey] = useState("untitled");
  const [defaultValue, setDefaultValue] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [savedMarkdown, setSavedMarkdown] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editorReady, setEditorReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialogMode | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const dirty = markdown !== savedMarkdown;
  const filename = target?.filename ?? "Untitled.md";
  const wordCount = useMemo(() => markdown.trim().split(/\s+/).filter(Boolean).length, [markdown]);

  const { threadId: chatThreadId, startNewChat } = useAppAgentChatSession({
    appId: "md-editor",
    scope: target?.relativePath ?? "untitled",
  });

  const applyLoaded = useCallback((next: OpenTarget, content: string) => {
    setTarget(next);
    setDefaultValue(content);
    setMarkdown(content);
    setSavedMarkdown(content);
    setDocumentKey(`${next.root}:${next.relativePath}:${Date.now()}`);
    setError("");
    setStatus("All changes saved");
    setEditorReady(false);
    document.title = `${next.filename} — jNotes`;
  }, []);

  const loadTarget = useCallback(
    async (next: OpenTarget) => {
      setLoading(true);
      setError("");
      try {
        const content = await readMarkdown(next);
        applyLoaded(next, content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setToast({ kind: "error", message: `Could not open ${next.filename}.` });
        setStatus("Failed to open file");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [applyLoaded],
  );

  // Bootstrap: files context + ArozOS / query open target.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ctx = await fetchFilesContext();
      if (cancelled) return;
      setFilesCtx(ctx);
      const open = resolveOpenTargetFromLocation(ctx);
      if (open) {
        await loadTarget(open).catch(() => undefined);
      } else {
        setLoading(false);
        setDefaultValue(EMPTY_DOCUMENT);
        setMarkdown(EMPTY_DOCUMENT);
        setSavedMarkdown(EMPTY_DOCUMENT);
        setDocumentKey(`untitled:${Date.now()}`);
        setStatus("Choose Save to name this note");
        document.title = "Untitled — jNotes";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTarget]);

  // Re-open when ArozOS changes the hash (another double-click into this window).
  useEffect(() => {
    const onHash = () => {
      const open = resolveOpenTargetFromLocation(filesCtx);
      if (open) void loadTarget(open).catch(() => undefined);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [filesCtx, loadTarget]);

  const saveDocument = useCallback(async (path?: string): Promise<string> => {
    const body = editorRef.current?.getMarkdown() ?? markdown;
    const nextTarget: OpenTarget | null = path
      ? {
          relativePath: normalizeMarkdownPath(path),
          root: "files",
          filename: normalizeMarkdownPath(path).split("/").pop() ?? "Untitled.md",
        }
      : target;
    if (!nextTarget) return "Choose a path with Save As before saving this untitled note.";

    setSaving(true);
    try {
      await writeMarkdown(nextTarget, body);
      setTarget(nextTarget);
      setMarkdown(body);
      setSavedMarkdown(body);
      setStatus("All changes saved");
      setError("");
      setPathDialog(null);
      setToast({ kind: "success", message: `Saved ${nextTarget.filename}` });
      document.title = `${nextTarget.filename} — jNotes`;
      return `Saved ${nextTarget.root}:${nextTarget.relativePath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setToast({ kind: "error", message: "Save failed. Your changes are still in the editor." });
      return `Save failed: ${msg}`;
    } finally {
      setSaving(false);
    }
  }, [markdown, target]);

  const newDocument = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes and start a new note?")) return;
    setTarget(null);
    setDefaultValue(EMPTY_DOCUMENT);
    setMarkdown(EMPTY_DOCUMENT);
    setSavedMarkdown(EMPTY_DOCUMENT);
    setDocumentKey(`untitled:${Date.now()}`);
    setError("");
    setStatus("Choose Save to name this note");
    setEditorReady(false);
    document.title = "Untitled — jNotes";
  }, [dirty]);

  const openFileRelative = useCallback(
    async (path: string): Promise<string> => {
      const clean = path.replace(/^\/+/, "").trim();
      if (!clean) return "openFile requires a path under joshu's files.";
      const next: OpenTarget = {
        relativePath: clean,
        root: "files",
        filename: clean.split("/").pop() ?? clean,
      };
      try {
        await loadTarget(next);
        setPathDialog(null);
        setToast({ kind: "info", message: `Opened ${next.filename}` });
        return `Opened files:${clean}`;
      } catch (err) {
        return `Open failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    [loadTarget],
  );

  const getGuiSnapshot = useCallback((): Record<string, unknown> => {
    const body = editorRef.current?.getMarkdown() ?? markdown;
    const capped =
      body.length > SNAPSHOT_MARKDOWN_CAP
        ? `${body.slice(0, SNAPSHOT_MARKDOWN_CAP)}\n\n…[truncated ${body.length - SNAPSHOT_MARKDOWN_CAP} chars — call getDocument for more]`
        : body;
    return {
      activeView: "editor",
      editorReady,
      dirty,
      file: target
        ? {
            path: target.relativePath,
            root: target.root,
            filename: target.filename,
            arozFilepath: target.arozFilepath ?? null,
          }
        : null,
      document: {
        filename,
        length: body.length,
        markdown: capped,
      },
    };
  }, [dirty, editorReady, filename, markdown, target]);

  guiRef.current = {
    getGuiSnapshot,
    getDocument: () => ({
      markdown: editorRef.current?.getMarkdown() ?? markdown,
      path: target ? `${target.root}:${target.relativePath}` : null,
      dirty,
      filename,
    }),
    replaceDocument: (md: string) => {
      editorRef.current?.replaceAll(md);
      setMarkdown(md);
      setStatus("Document replaced by agent");
    },
    insertMarkdown: (md: string, inline?: boolean) => {
      editorRef.current?.insert(md, inline);
      setMarkdown(editorRef.current?.getMarkdown() ?? markdown);
      setStatus("Markdown inserted");
    },
    appendMarkdown: (md: string) => {
      editorRef.current?.append(md);
      setMarkdown(editorRef.current?.getMarkdown() ?? markdown);
      setStatus("Markdown appended");
    },
    saveDocument,
    newDocument,
    openFile: openFileRelative,
  };

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey || !target) {
          setPathDialog("save");
        } else {
          void saveDocument();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setPathDialog("open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveDocument, target]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const handleSaveClick = () => {
    if (!target) {
      setPathDialog("save");
      return;
    }
    void saveDocument();
  };

  const handleEditorReady = () => {
    const normalized = editorRef.current?.getMarkdown() ?? markdown;
    setEditorReady(true);
    setMarkdown(normalized);
    setSavedMarkdown(normalized);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <PenLine size={19} />
        </div>
        <div className="document-identity">
          <h1>{filename}</h1>
          <p className="path-line">
            {target ? `${target.root === "files" ? "joshu's files" : "Desktop"} / ${target.relativePath}` : "New note"}
          </p>
        </div>
        <div className="topbar-actions" aria-label="Document actions">
          <button type="button" className="icon-button labeled-button" onClick={newDocument}>
            <FilePlus2 aria-hidden="true" size={17} />
            <span>New</span>
          </button>
          <button
            type="button"
            className="icon-button labeled-button"
            onClick={() => setPathDialog("open")}
          >
            <FolderOpen aria-hidden="true" size={17} />
            <span>Open</span>
          </button>
          <button
            type="button"
            className="button button-primary save-button"
            onClick={handleSaveClick}
            disabled={saving || !editorReady}
          >
            {saving ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <Save aria-hidden="true" size={17} />}
            <span>{target ? "Save" : "Save note"}</span>
          </button>
        </div>
      </header>

      <main className="editor-frame">
        {loading ? (
          <div className="editor-skeleton" aria-label="Loading note">
            <span className="skeleton-line skeleton-title" />
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-short" />
            <span className="skeleton-line" />
          </div>
        ) : (
          <MilkdownEditor
            ref={editorRef}
            documentKey={documentKey}
            defaultValue={defaultValue}
            onMarkdownUpdated={setMarkdown}
            onReady={handleEditorReady}
          />
        )}
      </main>

      <footer className="statusbar">
        <span>{wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}</span>
        <span>{markdown.length.toLocaleString()} characters</span>
        <span className="save-state" data-dirty={dirty || !target}>
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={14} />
          ) : dirty || !target ? (
            <span className="dirty-dot" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" size={14} />
          )}
          <span>{saving ? "Saving…" : dirty ? "Unsaved changes" : !target ? "Not saved yet" : status}</span>
        </span>
        <span className="shortcut-hint">⌘S save · ⌘O open</span>
      </footer>

      {error ? (
        <div className="inline-alert" role="alert">
          <CircleAlert aria-hidden="true" size={17} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          {toast.kind === "success" ? <Check aria-hidden="true" size={17} /> : null}
          {toast.kind === "error" ? <CircleAlert aria-hidden="true" size={17} /> : null}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      ) : null}

      {pathDialog ? (
        <PathDialog
          key={pathDialog}
          mode={pathDialog}
          initialValue={
            pathDialog === "save"
              ? target?.root === "files"
                ? target.relativePath
                : filename === "Untitled.md"
                  ? "Notes/Untitled.md"
                  : filename
              : ""
          }
          busy={saving || loading}
          onClose={() => setPathDialog(null)}
          onSubmit={(path) => pathDialog === "save" ? saveDocument(path) : openFileRelative(path)}
        />
      ) : null}

      <MdEditorAgentBridge key={chatThreadId} guiRef={guiRef} threadId={chatThreadId} onNewChat={startNewChat} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  // Avoid React StrictMode double-mount — Crepe/ProseMirror is not idempotent on create/destroy.
  createRoot(rootEl).render(<App />);
}
