import type { CwmObject, CwmProposal, CwmWorkspace } from "./types.js";

export const MAX_CWM_HANDOFF_MARKDOWN_LENGTH = 48_000;
const MAX_SECTION_ITEMS = 12;
const MAX_ITEM_TEXT = 600;
const MAX_SECTION_LENGTH = 8_000;

export interface CwmHandoffClassification {
  readonly decisionsAndCommitments: readonly CwmObject[];
  readonly tasks: readonly CwmObject[];
  readonly evidence: readonly CwmObject[];
  readonly unresolvedQuestions: readonly CwmObject[];
  readonly rejectedOptions: readonly {
    readonly object: CwmObject;
    readonly proposal: CwmProposal;
  }[];
}

export interface RenderCwmHandoffInput {
  readonly workspace: CwmWorkspace;
  readonly boardPath: string;
  readonly sessionStartedAt?: string;
  readonly consolidatedAt: string;
}

function byUpdatedAt(left: CwmObject, right: CwmObject): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

/**
 * Classify materialized objects only. Pending proposal operations are deliberately inspected
 * nowhere; dismissed decisions from rejected proposals stay in a recoverable lane.
 */
export function classifyCwmHandoff(workspace: CwmWorkspace): CwmHandoffClassification {
  const accepted = Object.values(workspace.objects);
  const decisionsAndCommitments = accepted
    .filter((object) => object.kind === "decision" && object.phase === "accepted")
    .sort(byUpdatedAt);
  const unresolvedQuestions = accepted
    .filter((object) => object.kind === "open_question" && object.phase !== "dismissed")
    .sort(byUpdatedAt);
  const evidence = accepted
    .filter((object) => object.kind === "note" && object.phase !== "dismissed")
    .sort(byUpdatedAt);
  const rejectedOptions = Object.values(workspace.proposals)
    .filter((proposal) => proposal.status === "REJECTED")
    .flatMap((proposal) =>
      proposal.operations.flatMap((operation) =>
        operation.type === "UPSERT_OBJECT" && operation.object.kind === "decision"
          ? [{ object: operation.object, proposal }]
          : [],
      ),
    )
    .slice(0, MAX_SECTION_ITEMS);

  return {
    decisionsAndCommitments: decisionsAndCommitments.slice(0, MAX_SECTION_ITEMS),
    // Tasks folded into decisions in the simplified vocabulary.
    tasks: [],
    evidence: evidence.slice(0, MAX_SECTION_ITEMS),
    unresolvedQuestions: unresolvedQuestions.slice(0, MAX_SECTION_ITEMS),
    rejectedOptions,
  };
}

function oneLine(value: string, max = MAX_ITEM_TEXT): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function markdownText(value: string, max = MAX_ITEM_TEXT): string {
  return oneLine(value, max).replace(/([\\`*_{}[\]<>])/g, "\\$1");
}

function linkUri(value: string): string {
  return value.replace(/[\r\n<>]/g, "").slice(0, 512);
}

function proposalRationale(workspace: CwmWorkspace, objectId: string): string | undefined {
  return Object.values(workspace.proposals)
    .filter((proposal) => proposal.status === "CONFIRMED")
    .sort((left, right) =>
      (right.resolvedAt ?? right.createdAt).localeCompare(left.resolvedAt ?? left.createdAt),
    )
    .find((proposal) =>
      proposal.operations.some(
        (operation) => operation.type === "UPSERT_OBJECT" && operation.object.id === objectId,
      ),
    )?.rationale;
}

function renderObject(
  object: CwmObject,
  workspace: CwmWorkspace,
  rationaleOverride?: string,
): string {
  const title = markdownText(object.title || object.kind, 160);
  const rationale = rationaleOverride || proposalRationale(workspace, object.id);
  const lines = [
    `### ${title}`,
    `- Semantic state: ${object.kind} · ${object.phase}`,
    ...(rationale ? [`- Rationale: ${markdownText(rationale)}`] : []),
    ...(object.provenance.length ? ["- Provenance:", ...provenanceLines(object)] : []),
    "",
    markdownText(object.body),
  ];
  return lines.join("\n");
}

function provenanceLines(object: CwmObject): string[] {
  return object.provenance.slice(0, 6).map((provenance) => {
    const label = markdownText(
      provenance.sourceId || provenance.locator || provenance.kind,
      180,
    );
    const link = provenance.sourceUri
      ? `[${label || "source"}](<${linkUri(provenance.sourceUri)}>)`
      : label || provenance.kind;
    const locator = provenance.locator
      ? ` · locator: ${markdownText(provenance.locator, 240)}`
      : "";
    return `  - ${link}${locator}`;
  });
}

function renderSection(
  heading: string,
  entries: readonly string[],
  emptyMessage: string,
): string {
  const included: string[] = [];
  let length = heading.length + 5;
  for (const entry of entries) {
    if (length + entry.length + 2 > MAX_SECTION_LENGTH) break;
    included.push(entry);
    length += entry.length + 2;
  }
  return [`## ${heading}`, "", ...(included.length ? included : [emptyMessage])].join("\n");
}

function earliestWorkspaceTime(workspace: CwmWorkspace): string | undefined {
  return [
    ...Object.values(workspace.objects).map((object) => object.createdAt),
    ...Object.values(workspace.proposals).map((proposal) => proposal.createdAt),
  ].sort()[0];
}

/** Render a deterministic, bounded, gbrain-indexable session handoff. */
export function renderCwmSessionMarkdown(input: RenderCwmHandoffInput): string {
  const classified = classifyCwmHandoff(input.workspace);
  const startedAt =
    oneLine(input.sessionStartedAt ?? earliestWorkspaceTime(input.workspace) ?? input.consolidatedAt, 64);
  const boardPath = oneLine(input.boardPath, 2_000);
  const boardUri = `joshu://${boardPath.replace(/^\/+/, "")}`;
  const sections = [
    renderSection(
      "Accepted decisions",
      classified.decisionsAndCommitments.map((object) => renderObject(object, input.workspace)),
      "_No accepted decisions._",
    ),
    renderSection(
      "Notes",
      classified.evidence.map((object) => renderObject(object, input.workspace)),
      "_No notes._",
    ),
    renderSection(
      "Open questions",
      classified.unresolvedQuestions.map((object) => renderObject(object, input.workspace)),
      "_No open questions._",
    ),
    renderSection(
      "Dismissed decisions",
      classified.rejectedOptions.map(({ object, proposal }) =>
        renderObject(object, input.workspace, proposal.rationale || "Dismissed during review"),
      ),
      "_No dismissed decisions to recover._",
    ),
  ];
  const markdown = [
    "---",
    "type: cwm-session",
    `board_path: ${JSON.stringify(boardPath)}`,
    `session_started_at: ${JSON.stringify(startedAt)}`,
    `consolidated_at: ${JSON.stringify(oneLine(input.consolidatedAt, 64))}`,
    `cwm_head_sequence: ${input.workspace.headSequence}`,
    "---",
    "",
    "# Curatorial Whiteboard session handoff",
    "",
    `- Board: [${markdownText(boardPath, 2_000)}](<${linkUri(boardUri)}>)`,
    `- Session time: ${markdownText(startedAt, 64)} → ${markdownText(input.consolidatedAt, 64)}`,
    `- Accepted CWM head: ${input.workspace.headSequence}`,
    "",
    ...sections,
    "",
  ].join("\n");

  return markdown.length <= MAX_CWM_HANDOFF_MARKDOWN_LENGTH
    ? markdown
    : `${markdown.slice(0, MAX_CWM_HANDOFF_MARKDOWN_LENGTH - 24)}\n\n_[Handoff truncated]_\n`;
}
