/**
 * Audience registers for the saved research markdown.
 *
 * The engine's --register only applies to --emit=md|html|compact. Joshu runs
 * --emit=json for the Results UI, then writes our own .md. These presets match
 * skills/last30days/scripts/lib/registers.py so Writing style still shapes
 * the file on disk.
 */

export type AudienceRegisterName = "default" | "exec" | "dev" | "creator" | "eli5";

export type AudienceSection =
  | "hiring_signals"
  | "clusters"
  | "stats"
  | "best_takes"
  | "top_comments"
  | "source_outcomes"
  | "source_coverage";

export type AudienceRegister = {
  name: AudienceRegisterName;
  label: string;
  /** One-line note in the saved brief (not shown in the Results UI). */
  blurb: string;
  sectionOrder: readonly AudienceSection[];
  clusterBudget: number | null;
  bestTakes: number;
  topComments: number;
  /** Multiplier on comparable engagement by source family. */
  emphasis: Readonly<Record<string, number>>;
};

const DEFAULT_ORDER: AudienceSection[] = [
  "hiring_signals",
  "clusters",
  "stats",
  "best_takes",
  "top_comments",
  "source_outcomes",
  "source_coverage",
];

const REGISTERS: Record<AudienceRegisterName, AudienceRegister> = {
  default: {
    name: "default",
    label: "Default",
    blurb: "",
    sectionOrder: DEFAULT_ORDER,
    clusterBudget: null,
    bestTakes: 0,
    topComments: 0,
    emphasis: {},
  },
  exec: {
    name: "exec",
    label: "Executive",
    blurb: "Executive brief — volume first, then the handful of clusters that moved.",
    sectionOrder: [
      "stats",
      "clusters",
      "hiring_signals",
      "source_outcomes",
      "source_coverage",
      "best_takes",
      "top_comments",
    ],
    clusterBudget: 5,
    bestTakes: 2,
    topComments: 3,
    emphasis: { polymarket: 1.5, jobs: 1.3, github: 1.2, grounding: 1.1 },
  },
  dev: {
    name: "dev",
    label: "Technical",
    blurb: "Technical brief — code, HN, and papers weighted above social chatter.",
    sectionOrder: [
      "clusters",
      "source_outcomes",
      "source_coverage",
      "hiring_signals",
      "stats",
      "top_comments",
      "best_takes",
    ],
    clusterBudget: 10,
    bestTakes: 3,
    topComments: 4,
    emphasis: { github: 1.6, hackernews: 1.35, arxiv: 1.3, grounding: 1.1 },
  },
  creator: {
    name: "creator",
    label: "Creator",
    blurb: "Creator brief — comments and social takes first, then the clusters.",
    sectionOrder: [
      "best_takes",
      "top_comments",
      "stats",
      "clusters",
      "hiring_signals",
      "source_outcomes",
      "source_coverage",
    ],
    clusterBudget: 6,
    bestTakes: 5,
    topComments: 8,
    emphasis: {
      tiktok: 1.6,
      instagram: 1.5,
      youtube: 1.4,
      x: 1.2,
      reddit: 1.1,
    },
  },
  eli5: {
    name: "eli5",
    label: "Plain language",
    blurb:
      "Plain-language brief — same findings as Results; cluster titles are unchanged (the engine does not rewrite JSON prose).",
    sectionOrder: DEFAULT_ORDER,
    clusterBudget: null,
    bestTakes: 0,
    topComments: 0,
    emphasis: {},
  },
};

export function parseAudienceRegister(raw?: string | null): AudienceRegisterName {
  const name = (raw || "default").trim().toLowerCase();
  if (name === "exec" || name === "dev" || name === "creator" || name === "eli5") return name;
  return "default";
}

export function getAudienceRegister(raw?: string | null): AudienceRegister {
  return REGISTERS[parseAudienceRegister(raw)];
}

/** Map engine source strings onto register emphasis keys. */
export function sourceFamily(source: string): string {
  const s = (source || "").toLowerCase();
  if (s.includes("github")) return "github";
  if (s.includes("hacker") || s === "hn" || s.includes("hackernews")) return "hackernews";
  if (s.includes("arxiv")) return "arxiv";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("youtube")) return "youtube";
  if (s === "x" || s.includes("twitter") || s.includes("xquik")) return "x";
  if (s.includes("reddit")) return "reddit";
  if (s.includes("polymarket")) return "polymarket";
  if (s.includes("job")) return "jobs";
  if (s.includes("grounding") || s === "web" || s.includes("exa") || s.includes("duck")) {
    return "grounding";
  }
  return s;
}

export function sourceEmphasis(source: string, emphasis: Readonly<Record<string, number>>): number {
  if (!emphasis || Object.keys(emphasis).length === 0) return 1;
  return emphasis[sourceFamily(source)] ?? 1;
}

export function registerFromArgv(argv?: string[]): AudienceRegisterName {
  if (!argv?.length) return "default";
  for (const arg of argv) {
    if (arg.startsWith("--register=")) {
      return parseAudienceRegister(arg.slice("--register=".length));
    }
  }
  return "default";
}
