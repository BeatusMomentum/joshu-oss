# Curatorial Whiteboard (local prototype)

The **Curatorial Whiteboard Model (CWM)** is the local semantic and review layer
implemented for jWhiteboard. Excalidraw remains the visual canvas and durable
`.excalidraw` scene format; CWM adds typed meaning, provenance, proposals,
authority rules, and an append-only audit trail beside an eligible board.

This document describes the completed **local prototype**. It does not describe
a deployed service or a collaboration backend.

## Principles

1. **Separate appearance from meaning.** Excalidraw elements own rendering and
   geometry. The CWM sidecar owns semantic objects, relations, regions, status,
   provenance, focus, and proposals. Scene bindings connect the two by opaque
   element IDs.
2. **Separate evidence, interpretation, and commitment.** Material does not
   become a decision merely because it appears on the board.
3. **Preserve provenance and disagreement.** Source links, excerpts,
   uncertainty, contradictions, open questions, and rejected options remain
   inspectable.
4. **AI proposes; a human disposes.** Agent-authored semantics begin as
   `PROPOSED`. Agent actions cannot accept, reject, commit, delete, bind raw
   scene elements, or patch scene JSON.
5. **Prefer bounded context.** Agent snapshots, retrieval packets, pointer
   history, transactions, and handoffs have explicit limits.
6. **Make change recoverable.** Durable changes are represented by ordered,
   append-only events. Reversible changes store inverse operations and undo is
   another compensating event, never deletion or rewriting of history.

## Three semantic layers and statuses

Every semantic object belongs to one layer:

- `EVIDENCE` — sources, extracts, observations, and other grounding material.
- `SENSEMAKING` — claims, questions, hypotheses, clusters, options, comments,
  and interpretations.
- `COMMITMENT` — accepted decisions, tasks, and other explicit commitments.

Objects, relations, and regions use these statuses:

- `CAPTURED` — recorded without an endorsement claim.
- `PROPOSED` — staged for review and not yet accepted.
- `ENDORSED` — explicitly supported by a human.
- `DISPUTED` — explicitly contested or unresolved.
- `DECIDED` — explicitly committed or decided.
- `ARCHIVED` — retained but no longer active.

The model also supports workflow modes `ORIENT`, `CURATE`, `DIVERGE`,
`CONVERGE`, and `COMMIT`. A mode is guidance, not authority: entering a mode
does not itself endorse an object or accept a proposal.

## Local architecture

The prototype has four local pieces:

1. `@joshu/whiteboard-cwm` is a pure TypeScript package containing the model,
   validation, operation reducer, authority policy, inverse derivation, event
   replay, and bounded handoff renderer.
2. The Joshu server exposes a localhost-only Express API and persists boards,
   sidecars, event logs, checkpoints, and handoffs under the resolved
   `joshu's files` root.
3. The jWhiteboard React wrapper loads the CWM workspace, renders the semantic
   inspector and review tray, materializes confirmed proposals, captures the
   Joshu Pointer, and supplies bounded context to the embedded agent.
4. The embedded app agent uses the `whiteboard-gui` skill and a restricted set
   of semantic GUI actions. File Brain and Hindsight are accessed through the
   platform data API for bounded recall.

The semantic sidecar is materialized state for fast loading. The JSONL event log
is the durable audit order and recovery source. The `.excalidraw` file remains
the durable visual checkpoint.

## Board eligibility

CWM activates only when jWhiteboard can prove that the loaded file is:

- a clean, relative path;
- lowercase `.excalidraw`;
- under the resolved `joshu's files` root; and
- an existing regular file, not a symlink.

An ArozOS `/media` file open is eligible only when its path begins with the
specific `user:/Desktop/<joshu-files-directory>/` prefix. Arbitrary Desktop
files, imported local files, Markdown files, absolute paths, paths containing
empty/`.`/`..` segments, and paths whose location cannot be established are
ineligible. The UI remains usable as an ordinary whiteboard, but CWM controls
show an inactive status.

Opening an eligible board for the first time creates the two CWM sidecars.

## Exact files and persistence semantics

For an eligible board:

```text
Planning/strategy.excalidraw
Planning/strategy.excalidraw.cwm.json
Planning/strategy.excalidraw.cwm.events.jsonl
```

- `<board>.cwm.json` is the validated materialized CWM workspace.
- `<board>.cwm.events.jsonl` is the append-only event stream. Each non-empty
  line is one complete JSON event with a contiguous `sequence`.
- `<board>` itself is replaced only by an explicit CWM checkpoint using a
  validated Excalidraw scene envelope.

Mutations are serialized by board path and use optimistic concurrency:
the caller supplies `headSequence`; a stale head receives HTTP `409` with the
actual head. For a successful mutation, the backend:

1. validates and reduces the proposed event;
2. appends and `fsync`s the event line;
3. atomically renames an optional staged artifact, such as the scene checkpoint
   or handoff;
4. atomically renames the updated workspace sidecar.

If a process stops after append but before the workspace rename, the next load
replays the durable event tail and repairs `<board>.cwm.json`. Sidecar and
artifact temporary files are created in the destination directory with mode
`0600`; event files are appended with no-follow behavior where supported.

Events include `OPERATIONS_APPLIED`, `PROPOSAL_CREATED`,
`PROPOSAL_CONFIRMED`, `PROPOSAL_REJECTED`, and `COMPENSATION_APPLIED`.
Reversible materializing events store the exact pre-application
`inverseOperations`. Compensation appends a new event naming
`compensatesEventId` and applies those inverses. It does not remove or edit the
original event, and the same event cannot be compensated twice through the
service. Compensation reverses CWM semantic operations; the prototype does not
retain prior `.excalidraw` checkpoint bytes or delete a previously written
handoff.

## Local API

The server mounts these routes at `/joshu/api/excalidraw/cwm`:

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/board?path=…` | Load or bootstrap the materialized workspace. |
| `GET` | `/events?path=…&afterSequence=…&limit=…` | Read a bounded event tail; `limit` is 1–500. |
| `POST` | `/create` | Exclusively create a blank board and initialize its CWM sidecars. |
| `POST` | `/proposal` | Classify semantic operations and either apply or stage them. |
| `POST` | `/confirm` | Human-confirm a pending proposal and apply its operations. |
| `POST` | `/reject` | Human-reject a pending proposal without applying it. |
| `POST` | `/compensate` | Append the stored inverse of a materializing event. |
| `POST` | `/checkpoint` | Validate and atomically replace the `.excalidraw` scene. |
| `POST` | `/consolidate` | Atomically write a bounded Markdown session handoff. |

Creation includes only `path` because the new workspace starts at sequence zero.
All other mutation requests include `path` and `headSequence`. Proposal requests
add `operations`; review requests add `proposalId`; compensation adds `eventId`;
checkpoint adds `scene`; consolidation adds `markdown` and may add a plain `.md`
`fileName`.

The API accepts only localhost requests. It grants CORS only to
`localhost`/`127.0.0.1` origins and supports local ArozOS `:8787` calling the
Joshu server on `:8788`. The frontend override is
`VITE_JOSHU_CWM_API_BASE`; the normal base is resolved automatically.

## Authority policy and explicit review

Transactions take the strongest class of any included operation:

| Class | Examples | Disposition |
|-------|----------|-------------|
| `EPHEMERAL` | focus | Apply immediately; not durable semantic authority. |
| `MECHANICAL` | scene binding, checkpoint marker | Apply immediately with stored inverse where material state changes. |
| `ORGANIZATIONAL` | mode, region, relation | Stage as a reversible proposal. |
| `EPISTEMIC` | evidence/sensemaking object, opening brief | Require confirmation. |
| `COMMITMENT` | commitment-layer object or deletion of one | Require confirmation. |

Pending proposals appear as visually distinct previews and in the **Review
tray**. **Accept** first durably confirms the proposal, then materializes its
scene representation and checkpoints the accepted scene. **Reject** removes
the preview and records rejection without changing accepted semantics.

The selection inspector provides explicit human **Endorse**, **Mark disputed**,
and **Commit/Decide** actions. These actions also enter the review tray before
changing accepted semantic state. Pending proposals are excluded from accepted
session handoffs.

## Embedded agent, actions, skill, and Start Session

jWhiteboard embeds its own app-agent thread scoped to the eligible board. The
manifest selects the `whiteboard-gui` skill and declares use of `joshu-brain`
and `ea-time-block`.

The agent can call only:

- `recallToBoard(query, limit?)` — retrieve and stage up to six source cards;
- `stageOpening(brief, sources?)` — stage an opening brief and source cards;
- `proposeTransaction(transaction)` — stage validated semantic upserts;
- `showFocus(focus)` — update ephemeral semantic focus;
- `focusRegion(regionId)` — navigate to an existing region;
- `openBoard(path)` — open another eligible relative board.

The bridge does not expose raw Excalidraw mutation, scene binding, removal,
commitment, confirmation, acceptance, or rejection. When the board window is
open, Hermes must not fall back to `write_file` / `patch` / the diagram
`excalidraw` skill: those edit the file on disk while the live canvas does not
auto-reload. Board mutations go through `app_gui_action` and appear first as
Review-tray proposals. AI-created objects and
relations require source-linked provenance, are forced to `PROPOSED`, and may
use only `EVIDENCE` or `SENSEMAKING`. AI transactions cannot enter `COMMIT`
mode.

**Start Session** sends a programmatic prompt to the embedded agent. The skill
instructs it to inspect the current bounded GUI snapshot, optionally retrieve a
small grounding packet, preserve tensions and open questions, offer two or
three possible starts, and call `stageOpening`. The result remains visibly
staged until a human accepts or rejects it.

## Bounded agent snapshot

The agent receives a compact GUI snapshot, not the raw scene:

- active viewport and zoom;
- loaded file;
- up to 20 selected element IDs;
- up to 12 focused region IDs;
- opening brief;
- one pending proposal summary with up to 16 operation summaries;
- at most 40 ranked scene-preview elements.

Selection and focused objects outrank visible and off-screen elements.
Element text is capped at 120 characters and the serialized snapshot is capped
at **8 KiB**. Preview items are removed until the envelope fits; if necessary,
proposal operations, selection, and focused-region IDs are reduced as well.

## Joshu Pointer, voice alignment, and grounding

**Joshu Pointer** is an implemented wrapper-owned overlay, not an Excalidraw
scene element. While enabled it captures scene-coordinate traces, keeps at most
500 downsampled points from the latest 30 seconds, renders the active stroke,
and fades completed strokes after one second. Traces are ephemeral and are not
written to the `.excalidraw` file or CWM sidecars.

On pointer-up, the resolver considers:

1. explicit Excalidraw selection (`1.0` confidence);
2. a closed lasso (`0.92`);
3. path pass-through (`0.62`);
4. a nearby sweep (`0.52`);
5. no match (`0`).

Results are capped at 20 candidate elements and mapped to bound CWM objects.
Confidence below `0.7` sets `groundingRequired`. The skill must visibly call
`showFocus` and ask one compact confirmation question before making a
consequential proposal from such a reference.

Only a **final** voice transcript that finishes from 0 through **1200 ms after**
the latest trace is aligned with that trace. The utterance is capped at 400
characters. Earlier, later, empty, or partial transcripts do not bind.
Voice proposal decisions use only the exact phrases `accept proposal` and
`reject proposal`, and run only when exactly one proposal is pending. This is a
convenience path to the same visible review operation, not broader voice
authority.

## Bounded File Brain and Hindsight recall

`recallToBoard` queries File Brain (gbrain-backed files) and Hindsight memory in
parallel. One source may fail; the action fails only when both fail or neither
returns usable evidence.

The query is capped at 500 characters and the requested result count is clamped
to 1–6. Response-envelope traversal is defensive: at most 100 nodes, depth
four, 24 candidates per lane, and 600 characters per card. Results are
deduplicated by normalized text and alternate file and memory lanes when both
are available.

Recall creates `Source` / `EVIDENCE` / `PROPOSED` objects with `FILE` or
`MEMORY` provenance and stages them for review. It does not accept cards, write
Hindsight memory, or perform broad unbounded retrieval.

## Consolidation handoff

**Consolidate Session**:

1. removes pending preview elements from the accepted scene;
2. atomically checkpoints the accepted `.excalidraw` scene;
3. renders a deterministic Markdown handoff from the checkpointed CWM head;
4. writes it under `Planning/cwm-sessions/`;
5. appends a mechanical consolidation event.

Default names have this form:

```text
Planning/cwm-sessions/cwm-session-<ISO-timestamp>-<event-id>.md
```

The handoff contains accepted decisions and commitments, tasks, evidence,
unresolved questions, and rejected-but-recoverable options. Pending proposal
operations are omitted. Each section includes at most 12 items, provenance is
bounded, sections are capped, and the whole artifact is at most 48,000
characters. The Markdown is intended for normal gbrain indexing and links back
to the board with a `joshu://` URI.

## User workflow

1. Select **New Board**, enter a name, and jWhiteboard creates the blank board
   under `Planning/`; or open an existing durable `.excalidraw` board under
   `joshu's files`.
2. Confirm the Curatorial workspace status is **ready**.
3. Select ordinary canvas elements and type them by object kind, layer, and
   status. Review the resulting proposal.
4. Accept or reject proposals in the review tray. Use the selection inspector
   to endorse, dispute, or commit already typed objects.
5. Create soft regions for navigation and focus.
6. Use **Joshu Pointer** while speaking to ground “this,” “these,” or a sweep;
   confirm low-confidence highlighting before consequential proposals.
7. Use **Start Session** or the embedded chat for a staged opening, and use
   bounded recall only when the board lacks grounding.
8. Select **Consolidate Session** to checkpoint accepted visual state and write
   the indexable session handoff.

Browser `localStorage` still provides convenience recovery for ordinary canvas
work. It is not the CWM durable record and does not replace explicit
checkpointing.

## Environment and local commands

Run from the repository root.

The normal integrated path is:

```bash
npm run dev:arozos
```

Open `http://127.0.0.1:8787`, sign in, and launch **jWhiteboard**. The local
Joshu API runs on `:8788`; CWM resolves that cross-port route automatically.

For separate frontend/backend iteration:

```bash
npm run dev
VITE_JOSHU_FILES_API_BASE=http://127.0.0.1:8788/joshu/api/files \
VITE_JOSHU_CWM_API_BASE=http://127.0.0.1:8788/joshu/api/excalidraw/cwm \
npm run dev:excalidraw
```

Relevant environment:

| Variable | Use |
|----------|-----|
| `AROZ_DATA` | ArozOS data root; defaults locally to `.local/arozos-data`. |
| `JOSHU_AROZ_USER` | Selects the ArozOS user; required when multiple/production-style user resolution cannot be inferred. |
| `JOSHU_FILES_DIR_NAME` | User-visible files directory name; defaults to `joshu's files`. |
| `VITE_JOSHU_FILES_API_BASE` | Standalone frontend override for the local files/platform API. |
| `VITE_JOSHU_CWM_API_BASE` | Standalone frontend override for the CWM API. |

Build and test:

```bash
npm run build:excalidraw
npm test -w @joshu/whiteboard-cwm
npm run build
npm run test:excalidraw-cwm-backend
npx tsx --test apps/excalidraw/src/cwm/*.test.ts apps/excalidraw/src/agent/*.test.ts
```

The backend regression script covers bootstrap, traversal, localhost/CORS,
authority review, stale-head conflicts, compensation, checkpoint validation,
handoff writing, event-tail repair, and concurrent writers.

## Security, traversal, validation, and concurrency

- The API is localhost-only and CORS is restricted to local origins.
- Only clean relative lowercase `.excalidraw` paths are accepted.
- Unix and Windows path separators are normalized before rejecting absolute
  paths, empty segments, `.`/`..`, NULs, and traversal.
- The board must be a regular non-symlink file. Sidecars and event logs reject
  symlinks. Resolved board paths must remain inside the resolved files root.
- Handoff names must be plain `.md` basenames and always resolve under
  `Planning/cwm-sessions/`.
- Scene checkpoints require the complete JSON-only Excalidraw envelope:
  `type`, positive `version`, `elements`, `appState`, and `files`; nesting is
  limited to 50 levels.
- CWM data is runtime-validated and bounded. Default maxima include 500
  objects, 1,000 relations, 100 regions, 500 proposals, 200 operations per
  event, 10,000 replayed events, 20,000 characters per text value, and 128
  characters per ID.
- Per-board FIFO serialization plus optimistic `headSequence` prevents two
  callers from committing against the same head. One succeeds and stale
  callers receive `409`.
- Event append precedes materialized-sidecar replacement so a partial final
  write is recoverable by replay.

This is process-local concurrency control, not a distributed lock. Multiple
independent server processes writing the same board are outside the prototype
contract.

## Limitations and non-goals

- **No Markdown source writeback.** Saving/checkpointing CWM persists the
  `.excalidraw` board and its CWM sidecars only. Opening Markdown produces
  canvas content; it does not make the original `.md` writable.
- **Arbitrary `/media` Markdown remains read-only/import-only.** See
  [`excalidraw-markdown-wysiwyg.md`](excalidraw-markdown-wysiwyg.md).
- **No real-time or multi-user collaboration backend.**
- **No distributed concurrency or cross-process locking.**
- **No artifact version store.** Semantic compensation does not restore a prior
  `.excalidraw` checkpoint or remove an already consolidated handoff.
- **No deployment claim.** This document covers the completed local
  prototype; packaging and deployment are separate work.
- **No vendor change in this prototype.** CWM, the agent bridge, and Joshu
  Pointer are wrapper/server additions. The existing Markdown WYSIWYG fork is
  historical context, not a CWM vendor modification.
- **No broad memory write.** Recall reads bounded File Brain/Hindsight results
  and stages source cards; consolidation writes a local Markdown handoff.
- **No autonomous semantic authority.** The agent cannot accept, reject,
  endorse, commit, archive, delete, or directly mutate scene content.

## Prototype status

As of July 2026, the local prototype is implemented with:

- semantic layers, statuses, provenance, regions, relations, focus, proposals,
  authority classification, validation, event replay, and compensation;
- exact sibling sidecars, atomic scene checkpoints, optimistic concurrency,
  crash-tail repair, and bounded consolidation handoffs;
- the jWhiteboard semantic inspector, pending previews, explicit review tray,
  human promotion controls, and status handling;
- an embedded board-scoped agent, restricted semantic actions,
  `whiteboard-gui` skill, and **Start Session**;
- bounded GUI snapshots, File Brain/Hindsight recall, Joshu Pointer, voice
  alignment, and low-confidence grounding;
- package, frontend unit, and backend persistence regression coverage.

It is locally buildable and testable. Collaboration, Markdown source writeback,
deployment, and vendor changes are explicitly outside this prototype.
