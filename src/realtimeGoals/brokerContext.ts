import { formatSessionThreadForPrompt } from "./sessionThread.js";
import type { OwnerRoute, RealtimeGoalChannel, RealtimeGoalRecord, SessionThreadTurn } from "./types.js";
import { extractLinks } from "./voiceLinks.js";

const HERMES_THREAD_TURNS = 4;
const DETAIL_CHARS = 600;

/** Owner outbox delivery state for one goal (owner-scoped snapshot). */
export type GoalDeliveryNote = {
  heard: boolean;
  heardVia?: OwnerRoute;
  heardAt?: string;
  /** Owner-chosen route for this goal ("text me instead"). */
  route?: OwnerRoute;
  /** Latest callback attempt, e.g. "voicemail_left at <iso>". */
  lastCall?: string;
};

export type BrokerContextOptions = {
  notes?: Map<string, GoalDeliveryNote>;
  /** Outbound callbacks are configured on this box. */
  callbacksAvailable?: boolean;
  /** Callbacks are backing off after missed calls until this time. */
  callbackBackoffUntil?: string;
};

const CHANNEL_LABEL: Record<RealtimeGoalChannel, string> = {
  sms: "text",
  pstn_voice: "phone",
  browser_voice: "desktop voice",
  jchat: "jChat",
  agui: "app chat",
  slack: "Slack",
  telegram: "Telegram",
};

const ROUTE_LABEL: Record<OwnerRoute, string> = {
  voice: "phone",
  sms: "text",
  slack: "Slack",
  telegram: "Telegram",
  surface: "desktop",
};

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS)}…` : flat;
}

/**
 * Full links from this goal's latest output plus whether they reached the
 * owner's phone. Listed separately because the excerpt truncates, and workers
 * put the handoff URL last — without it Hermes cannot re-send or email the link
 * and falls back on stale memory.
 */
function linkFacts(goal: RealtimeGoalRecord, detail: string): string {
  const links = extractLinks(detail);
  if (links.length === 0) return "";
  const listed = `\n  Links: ${links.join(" ")}`;
  if (goal.linksTextedAt) return `${listed}\n  Texted to the owner's phone at ${goal.linksTextedAt}.`;
  // Text channels deliver the result (link included) as the message itself;
  // only a phone call can leave the owner with a link they never received.
  return goal.origin.channel === "pstn_voice"
    ? `${listed}\n  NOT texted to the owner yet (not sent anywhere they can tap).`
    : listed;
}

/** "(done; owner has NOT heard this yet)" etc. for owner-scoped snapshots. */
function deliveryLabel(goal: RealtimeGoalRecord, note: GoalDeliveryNote | undefined): string {
  if (!note) return "";
  if (note.heard) {
    return `; owner heard it${note.heardVia ? ` by ${ROUTE_LABEL[note.heardVia]}` : ""}`;
  }
  const waiting =
    goal.status === "blocked"
      ? "; question NOT yet answered by owner"
      : goal.status === "done" || goal.status === "failed"
        ? "; result NOT yet heard by owner — offer it"
        : "";
  const route = note.route ? `; owner asked for updates by ${ROUTE_LABEL[note.route]}` : "";
  const call = note.lastCall ? `; last callback: ${note.lastCall}` : "";
  return `${waiting}${route}${call}`;
}

/** One goal with what it is waiting on or what it found. */
function goalLine(
  goal: RealtimeGoalRecord,
  options: BrokerContextOptions = {},
): string {
  const note = options.notes?.get(goal.id);
  const head =
    `- ${goal.title} (${goal.status}; asked by ${CHANNEL_LABEL[goal.origin.channel]} at ${goal.createdAt}` +
    `${deliveryLabel(goal, note)})`;
  if (goal.status === "blocked" && goal.lastBlockReason) {
    return `${head}\n  Waiting on owner: ${excerpt(goal.lastBlockReason)}${linkFacts(goal, goal.lastBlockReason)}`;
  }
  if (goal.resultSummary) {
    return `${head}\n  Result: ${excerpt(goal.resultSummary)}${linkFacts(goal, goal.resultSummary)}`;
  }
  return head;
}

/** What the box can do about reaching the owner (so chat never says "I can't call"). */
function capabilityLines(options: BrokerContextOptions): string[] {
  const lines = [
    "Goals from every channel (phone, text, chat) belong to the same owner and are listed here.",
  ];
  if (options.callbacksAvailable) {
    lines.push(
      "Joshu CAN call the owner: results of phone requests arrive by callback (or by text if a call is missed). " +
        "If the owner asks to be called, the call is placed automatically — confirm it; never say you cannot dial out.",
    );
  }
  if (options.callbackBackoffUntil && Date.parse(options.callbackBackoffUntil) > Date.now()) {
    lines.push(`Callbacks are paused after a missed call until ${options.callbackBackoffUntil} unless the owner asks to be called.`);
  }
  return lines;
}

/** Compact broker snapshot for Hermes pass turns on queue-capable channels. */
export function buildHermesBrokerContextMessage(
  activeGoals: RealtimeGoalRecord[],
  threadTurns: SessionThreadTurn[],
  activeBranch?: RealtimeGoalRecord,
  recentlyFinished: RealtimeGoalRecord[] = [],
  options: BrokerContextOptions = {},
): string {
  const lines = [
    "Background work context (authoritative — do not contradict cancelled/queued state,",
    "and prefer these results over older memory of the same task):",
    ...capabilityLines(options),
  ];

  if (activeBranch) {
    lines.push(`Active branch: ${activeBranch.title} (${activeBranch.status})`);
  }

  if (activeGoals.length > 0) {
    lines.push("Open background goals and unheard results:");
    for (const goal of activeGoals.slice(0, 6)) lines.push(goalLine(goal, options));
  } else {
    lines.push("Active background goals: (none)");
  }

  if (recentlyFinished.length > 0) {
    lines.push("Recently finished:");
    for (const goal of recentlyFinished.slice(0, 4)) lines.push(goalLine(goal, options));
  }

  const recentThread = formatSessionThreadForPrompt(threadTurns, HERMES_THREAD_TURNS);
  if (recentThread !== "(empty)") {
    lines.push("", "Recent owner↔box thread:", recentThread);
  }

  return lines.join("\n");
}
