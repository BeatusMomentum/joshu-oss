---
name: jnotes-gui
description: jNotes desktop UI — WYSIWYG markdown editing via Milkdown; GUI-first agent rules when the window is open.
version: 0.1.0
metadata:
  hermes:
    category: files
---

# jNotes GUI skill

Use when the **jNotes window is open** (embedded chat or voice).

## Platform boundary (embedded — GUI first)

When jNotes is open, treat the **on-screen document** as the source of truth.

| User intent | Do this | Do NOT |
|-------------|---------|--------|
| Read / summarize / quote the open note | Read **`document.markdown`** from the GUI snapshot, or `app_gui_action` **`getDocument`** | gbrain / filesystem MCP first |
| Rewrite or draft into the note | `app_gui_action` **`replaceDocument`** / **`insertMarkdown`** / **`appendMarkdown`** | Paste-only in chat |
| Save | `app_gui_action` **`saveDocument`**; include `path` for an untitled note | — |
| Open another file under joshu's files | `app_gui_action` **`openFile`** with relative path | — |
| Search the wider Desktop / File Brain | `skill_view('joshu-brain')` → gbrain | — |

**Never delete files** from this skill. Draft in the editor; the user saves or discards.

## GUI snapshot fields

- **`activeView`**: always `editor` while jNotes is open
- **`file`**: `{ path, root, filename }` when a path is bound
- **`document.markdown`**: current body (may be truncated — use **`getDocument`** for the full text)
- **`dirty`**: unsaved changes

## Embedded chat rules

- UI changes → **`app_gui_action(appId="md-editor", action=…, args=…)`**
- After drafting content, put it in the editor via guiAction — do not only paste in chat.

## guiActions reference

| action | Effect |
|--------|--------|
| `replaceDocument` | Replace entire body (`markdown`) |
| `insertMarkdown` | Insert at cursor (`markdown`, optional `inline`) |
| `appendMarkdown` | Append to end |
| `getDocument` | Return path + markdown to the agent |
| `saveDocument` | Persist to disk (optional `path` under `joshu's files`) |
| `newDocument` | Blank untitled buffer |
| `openFile` | Open `path` under joshu's files |
