/**
 * Deterministic post-handoff evaluation — split outbound auth from internal reconcile.
 * High confidence → resolve (auto-complete). Doubt → clarify. Otherwise noop.
 */
import fs from "node:fs";
import path from "node:path";

import { blockReasonNeedsOwnerInput } from "../proactive/blockReason.js";

/** Default window for recent handoff signals (days). */
export const TRACK_SIGNAL_HANDOFF_WINDOW_DAYS = 30;

export type ParsedMailHandoff = {
  messageId: string;
  sourcePath: string;
  at: string;
  summary: string;
  from?: string;
};

export type TrackSignalVerdict =
  | { tier: "resolve"; reason: string; evidence: string }
  | { tier: "clarify"; reason: string; conflict: string }
  | { tier: "noop"; reason: string };

/** Strong confirmation — auto-complete only when matched in summary and/or mail mirror. */
const RESOLVE_CONFIRMATION_PATTERNS: RegExp[] = [
  /have you down to teach/i,
  /down to teach or co-teach/i,
  /\bconfirmed\b/i,
  /\bon the .{0,40}list\b/i,
  /\bregistered you\b/i,
  /\byou'?re on the\b/i,
  /\bi have you down\b/i,
  /have you down to/i,
  /\byou are on the\b/i,
];

/** Weaker signals — handoff is suggestive but not strong enough to auto-close. */
const SUGGESTIVE_PATTERNS: RegExp[] = [
  /\bconfirm/i,
  /\bregistered\b/i,
  /\bteacher list\b/i,
  /\bon the list\b/i,
  /\bteaching\b/i,
  /\bvolunteer list\b/i,
];

const OWNER_DECISION_TITLE = /owner decision|awaiting owner|owner review|owner input/i;

export function parseMailHandoffs(body: string): ParsedMailHandoff[] {
  const text = body ?? "";
  const out: ParsedMailHandoff[] = [];
  const blocks = text.split(/\nmail_handoff:\s*\n/i);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    const messageId = /^  message_id:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const sourcePath = /^  source_path:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const at = /^  at:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const from = /^  from:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const summaryMatch = /^  summary:\s*(.+)$/m.exec(block);
    let summary = summaryMatch?.[1]?.trim() ?? "";
    if (summary.startsWith('"') && summary.endsWith('"')) {
      try {
        summary = JSON.parse(summary) as string;
      } catch {
        summary = summary.slice(1, -1);
      }
    }
    if (messageId && sourcePath) {
      out.push({ messageId, sourcePath, at: at || new Date(0).toISOString(), summary, from });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function latestMailHandoff(body: string): ParsedMailHandoff | null {
  const all = parseMailHandoffs(body);
  return all.length ? all[all.length - 1]! : null;
}

function isHandoffRecent(handoff: ParsedMailHandoff, windowDays: number): boolean {
  const atMs = Date.parse(handoff.at);
  if (!Number.isFinite(atMs)) return true;
  return Date.now() - atMs <= windowDays * 86_400_000;
}

export function isOwnerDecisionTrack(opts: {
  title?: string;
  body?: string;
  blockReason?: string | null;
}): boolean {
  const title = opts.title ?? "";
  const body = opts.body ?? "";
  if (blockReasonNeedsOwnerInput(opts.blockReason)) return true;
  if (OWNER_DECISION_TITLE.test(title)) return true;
  if (OWNER_DECISION_TITLE.test(body)) return true;
  return false;
}

function readMailMirrorText(filesRoot: string, sourcePath: string): string | null {
  const fp = path.join(filesRoot, sourcePath.replace(/^\/+/, ""));
  try {
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

function textMatchesResolveConfirmation(...texts: string[]): boolean {
  const combined = texts.filter(Boolean).join("\n");
  return RESOLVE_CONFIRMATION_PATTERNS.some((p) => p.test(combined));
}

function textMatchesSuggestive(...texts: string[]): boolean {
  const combined = texts.filter(Boolean).join("\n");
  return SUGGESTIVE_PATTERNS.some((p) => p.test(combined));
}

export type EvaluateTrackSignalInput = {
  filesRoot: string;
  title?: string;
  body?: string;
  blockReason?: string | null;
  status?: string;
  handoffWindowDays?: number;
};

/** Evaluate whether a blocked track should resolve, clarify, or noop after handoff. */
export function evaluateTrackSignal(input: EvaluateTrackSignalInput): TrackSignalVerdict {
  const { filesRoot, title = "", body = "", blockReason, status } = input;
  const windowDays = input.handoffWindowDays ?? TRACK_SIGNAL_HANDOFF_WINDOW_DAYS;

  if (status && status !== "blocked") {
    return { tier: "noop", reason: "task_not_blocked" };
  }

  if (!isOwnerDecisionTrack({ title, body, blockReason })) {
    return { tier: "noop", reason: "not_owner_decision_track" };
  }

  const handoff = latestMailHandoff(body);
  if (!handoff) {
    return { tier: "noop", reason: "no_mail_handoff" };
  }

  if (!isHandoffRecent(handoff, windowDays)) {
    return { tier: "noop", reason: "handoff_too_old" };
  }

  const mirrorText = readMailMirrorText(filesRoot, handoff.sourcePath);
  const summary = handoff.summary.trim();
  const evidenceParts = [
    summary ? `Handoff summary: ${summary}` : "",
    mirrorText ? `Mail excerpt: ${mirrorText.slice(0, 400).replace(/\s+/g, " ")}` : "",
  ].filter(Boolean);

  if (textMatchesResolveConfirmation(summary, mirrorText ?? "")) {
    return {
      tier: "resolve",
      reason: "confirmation_signal",
      evidence: evidenceParts.join("\n"),
    };
  }

  // Mirror unreadable but summary is suggestive → clarify (not resolve).
  const suggestive =
    textMatchesSuggestive(summary, mirrorText ?? "") ||
    (mirrorText == null && summary.length > 20);

  if (suggestive) {
    const conflict = [
      `Open card: "${title.trim() || "(untitled)"}" still blocked (${blockReason ?? "owner input"}).`,
      `New mail handoff (${handoff.at}): ${summary || handoff.sourcePath}.`,
      "Should I close the decision track based on this mail, or is something still open?",
    ].join(" ");
    return { tier: "clarify", reason: "ambiguous_confirmation", conflict };
  }

  return { tier: "noop", reason: "handoff_not_actionable" };
}

/**
 * True when proactive should skip nudging — handoff implies decision already made (resolve tier).
 */
export function isTrackSupersededByHandoff(opts: {
  filesRoot: string;
  title?: string;
  body?: string;
  blockReason?: string | null;
  status?: string;
}): boolean {
  const verdict = evaluateTrackSignal({
    filesRoot: opts.filesRoot,
    title: opts.title,
    body: opts.body,
    blockReason: opts.blockReason,
    status: opts.status ?? "blocked",
  });
  return verdict.tier === "resolve";
}

/** Sweep should defer generic nudge — clarify path pending or ambiguous handoff not yet sent. */
export function shouldDeferSweepForHandoff(opts: {
  filesRoot: string;
  title?: string;
  body?: string;
  blockReason?: string | null;
  status?: string;
}): boolean {
  const verdict = evaluateTrackSignal({
    filesRoot: opts.filesRoot,
    title: opts.title,
    body: opts.body,
    blockReason: opts.blockReason,
    status: opts.status ?? "blocked",
  });
  return verdict.tier === "resolve" || verdict.tier === "clarify";
}

export type EvaluateTrackSignalAfterHandoffOpts = EvaluateTrackSignalInput & {
  taskId: string;
  board: string;
  projectSlug: string;
};

/** Convenience wrapper after handoff append (same inputs as evaluateTrackSignal). */
export function evaluateTrackSignalAfterHandoff(
  opts: EvaluateTrackSignalAfterHandoffOpts,
): TrackSignalVerdict {
  return evaluateTrackSignal(opts);
}
