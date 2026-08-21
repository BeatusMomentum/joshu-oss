import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "@joshu/app-agent/agentChat.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JoshuMultimodalApp } from "@joshu/app-agent";

import { LAST30DAYS_MANIFEST } from "./last30daysAppManifest.js";
import {
  createLast30DaysGuiActions,
  type Last30DaysGuiAgentApi,
  type Last30DaysNavId,
} from "./last30daysGuiActions.js";
import {
  indexClustersForDisplay,
  membersForCluster,
  filterItemsForDisplay,
  sourceCounts,
  sourceIssuesFromStatus,
  tryParseAgentReport,
  formatCompactCount,
} from "@joshu/last30days-format";

const API = (import.meta.env.VITE_LAST30DAYS_API_BASE || "/joshu/api/last30days").replace(
  /\/+$/,
  "",
);

/** Strip ANSI + Joshu-disabled “unlock cookie / yt-dlp / XAI” sales pitches from logs. */
function sanitizeLogLine(line: string): string | null {
  const plain = line
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trimEnd();
  const trimmed = plain.trim();
  if (!trimmed) return plain.length ? plain : null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("💡 unlock x") || lower.startsWith("unlock x:")) return null;
  if (lower.includes("from_browser=")) return null;
  if (lower.includes("auth_token/ct0") || lower.includes("xai_api_key") || lower.includes("xquik_api_key")) {
    return null;
  }
  if (lower.includes("brew install yt-dlp") || lower.includes("install yt-dlp")) return null;
  if (lower.startsWith("free fixes:")) return null;
  if (/^[-•]\s*x\/twitter/.test(lower) || /^[-•]\s*youtube:/.test(lower)) return null;
  if (lower.includes("log into x.com")) return null;
  if (lower.includes("last30days has no affiliation")) return null;
  if (lower.startsWith("your sc key also powers")) return null;
  // Upstream quality tip assumes yt-dlp; Joshu uses ScrapeCreators for YT instead.
  if (lower.startsWith("missing: x/twitter, youtube") || lower.startsWith("missing: youtube")) {
    return "Note: X is off in Joshu. YouTube uses ScrapeCreators when the planner queries it.";
  }
  return plain;
}

function appendSanitizedLog(prev: string[], line: string): string[] {
  const cleaned = sanitizeLogLine(line);
  if (cleaned == null) return prev;
  return [...prev.slice(-400), cleaned];
}

/** Pull human-facing warnings out of engine markdown briefs (emit=md). */
function extractMdReportAlerts(text: string): { warnings: string[]; issues: string[]; footer: string } {
  const warnings: string[] = [];
  const issues: string[] = [];

  const warningsBlock = text.match(/## Warnings\n([\s\S]*?)(?=\n## |\n<!--|$)/);
  if (warningsBlock) {
    for (const line of warningsBlock[1].split("\n")) {
      if (line.startsWith("- ")) warnings.push(line.slice(2).trim());
    }
  }

  const partialBlock = text.match(/## Partial Coverage\n\n>([\s\S]*?)(?=\n## |$)/);
  if (partialBlock) {
    for (const line of partialBlock[1].split("\n")) {
      const cleaned = line.replace(/^>\s?/, "").trim();
      if (cleaned) issues.push(cleaned);
    }
  }

  const errorsBlock = text.match(/## Source Errors\n\n([\s\S]*?)(?=\n<!--|\n## |$)/);
  if (errorsBlock) {
    for (const line of errorsBlock[1].split("\n")) {
      if (line.startsWith("- ")) issues.push(line.slice(2).trim());
    }
  }

  const footerMatch = text.match(/✅ All agents reported back![\s\S]*?---/);
  return { warnings, issues, footer: footerMatch?.[0]?.trim() || "" };
}

function stripMdAgentEnvelope(text: string): string {
  return text
    .replace(/<!-- USER-VISIBLE BANNER[\s\S]*?<!-- END USER-VISIBLE BANNER -->\n*/g, "")
    .replace(
      /<!-- EVIDENCE FOR SYNTHESIS[\s\S]*?<!-- END EVIDENCE FOR SYNTHESIS -->\n*/g,
      "",
    )
    .replace(/# END OF last30days CANONICAL OUTPUT[\s\S]*/g, "")
    .trim();
}

function ResearchReportView({
  text,
  onWatchTopic,
  alreadyWatched,
  watchLabel,
}: {
  text: string;
  onWatchTopic?: () => void;
  alreadyWatched?: boolean;
  watchLabel?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const report = useMemo(() => tryParseAgentReport(text), [text]);
  const mdAlerts = useMemo(
    () => (report ? null : extractMdReportAlerts(text)),
    [report, text],
  );
  // Hooks must run unconditionally — opening a saved JSON run used to crash here.
  const displayOpts = useMemo(
    () => ({ query: report?.query || "" }),
    [report?.query],
  );
  const displayItems = useMemo(
    () => filterItemsForDisplay(report?.results || [], displayOpts),
    [report, displayOpts],
  );
  const indexedClusters = useMemo(
    () => indexClustersForDisplay(report?.clusters || [], report?.results || [], displayOpts),
    [report, displayOpts],
  );

  useEffect(() => {
    setShowRaw(false);
  }, [text]);

  if (!text.trim()) {
    return <div className="result-box is-empty">Run research to see the brief here.</div>;
  }

  if (!report || showRaw) {
    const cleanedMd = report ? text : stripMdAgentEnvelope(text);
    return (
      <div className="result-stack">
        {report ? (
          <div className="row end">
            <button type="button" className="btn compact ghost" onClick={() => setShowRaw(false)}>
              Formatted
            </button>
          </div>
        ) : mdAlerts && (mdAlerts.warnings.length > 0 || mdAlerts.issues.length > 0) ? (
          <div className="report-alerts">
            {mdAlerts.warnings.map((w) => (
              <p key={w} className="alert warn">
                {w}
              </p>
            ))}
            {mdAlerts.issues.map((issue) => (
              <p key={issue} className="alert error">
                {issue}
              </p>
            ))}
            <p className="hint">
              This run used <strong>md</strong> output (agent/Hermes format). Re-run with default{" "}
              <strong>json</strong> for structured cluster cards in Results.
            </p>
          </div>
        ) : null}
        {mdAlerts?.footer ? <pre className="result-box footer-box">{mdAlerts.footer}</pre> : null}
        <div className="result-box">{cleanedMd}</div>
      </div>
    );
  }

  const clusters = report.clusters || [];
  const items = report.results || [];
  const groupedCount = indexedClusters.filter((entry) => entry.memberCount > 1).length;
  const counts = sourceCounts({ ...report, results: displayItems });
  const issues = sourceIssuesFromStatus(report.source_status);
  const missingExpected = !counts.some((c) => c.name === "youtube" && c.count > 0);
  const dropped = Math.max(0, items.length - displayItems.length);

  return (
    <div className="result-stack">
      <div className="report-meta">
        <div>
          <p className="eyebrow">Brief</p>
          <h2 className="report-title">{report.query || "Research"}</h2>
          {watchLabel ? <p className={`trend-pill ${alreadyWatched ? "on" : ""}`}>{watchLabel}</p> : null}
          <p className="hint">
            {report.window_days ? `${report.window_days}d window` : "window n/a"}
            {report.generated_at
              ? ` · ${new Date(report.generated_at).toLocaleString()}`
              : ""}
            {` · ${indexedClusters.length} clusters (${groupedCount} grouped) · ${displayItems.length} items`}
            {dropped > 0 ? ` · ${dropped} filtered` : ""}
            {" · sorted by relevance"}
          </p>
        </div>
        <div className="row">
          {onWatchTopic ? (
            <button
              type="button"
              className="btn compact primary"
              onClick={onWatchTopic}
              disabled={alreadyWatched}
            >
              {alreadyWatched ? "Watching" : "Watch this topic"}
            </button>
          ) : null}
          <button type="button" className="btn compact ghost" onClick={() => setShowRaw(true)}>
            Raw JSON
          </button>
        </div>
      </div>

      {issues.length > 0 ? (
        <div className="report-alerts">
          {issues.map((issue) => (
            <p key={issue} className="alert error">
              {issue}
            </p>
          ))}
        </div>
      ) : null}

      <div className="source-strip">
        {counts.length === 0 ? (
          <span className="source-chip muted">No source items</span>
        ) : (
          counts.map((c) => (
            <span
              key={c.name}
              className={`source-chip ${c.count === 0 ? "muted" : ""}`}
              title={c.status ? `${c.name}: ${c.status}` : c.name}
            >
              {c.name}
              <strong>
                {c.count}
                {c.nativeTotal > 0 ? ` · ${formatCompactCount(c.nativeTotal)} ${c.unit}` : ""}
              </strong>
            </span>
          ))
        )}
      </div>

      {missingExpected ? (
        <p className="hint policy-hint">
          YouTube and X run when this search includes them. Use Thorough under More options if a
          source looks thin.
        </p>
      ) : null}

      <div className="cluster-list">
        {indexedClusters.map(({ cluster, idx, memberCount, nativeLabel }, displayRank) => {
          const members = membersForCluster(items, idx, 6, displayOpts);
          return (
            <article
              key={`${cluster.title || "cluster"}-${idx}`}
              className={`cluster-card${memberCount <= 1 ? " is-singleton" : ""}`}
            >
              <header className="cluster-head">
                <span className="cluster-index">{displayRank + 1}</span>
                <div>
                  <h3>{cluster.title || `Cluster ${displayRank + 1}`}</h3>
                  {cluster.summary && cluster.summary !== cluster.title ? (
                    <p className="cluster-summary">{cluster.summary}</p>
                  ) : null}
                </div>
                <div className="cluster-stats">
                  {memberCount > 1 ? (
                    <span className="source-chip compact">{memberCount} items</span>
                  ) : null}
                  {(cluster.sources || []).map((s) => (
                    <span key={s} className="source-chip compact">
                      {s}
                    </span>
                  ))}
                  {nativeLabel ? <span className="engagement">{nativeLabel}</span> : null}
                </div>
              </header>
              {members.length > 0 ? (
                <ul className="item-list">
                  {members.map((item) => (
                    <li key={item.candidate_id || item.url || `${item.title}-${item.source}`}>
                      <div className="item-line">
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title || item.summary || item.url}
                          </a>
                        ) : (
                          <span>{item.title || item.summary || "Untitled"}</span>
                        )}
                        <span className="item-meta">
                          {item.source || "?"}
                          {item.published_at ? ` · ${item.published_at}` : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

type NavId = Last30DaysNavId;

type PublicConfig = {
  setupComplete?: boolean;
  includeSources?: string;
  excludeSources?: string;
  memoryDir?: string;
  store?: boolean;
  register?: string;
  scrapecreators?: { present: boolean; last4?: string; relay?: boolean };
  scrapecreatorsRelay?: { mode?: string; configured?: boolean };
  xquik?: { present: boolean; last4?: string; relay?: boolean };
  xquikRelay?: { mode?: string; configured?: boolean };
  policy?: Record<string, unknown>;
};

type WatchingTopicRow = {
  name: string;
  cadence: "daily" | "weekly";
  enabled: boolean;
  lastCheckedAt: string | null;
  snapshotCount: number;
  status: { kind: string; label: string };
};

type WatchReportPayload = {
  topic: string;
  trend: { kind: string; label: string };
  quietEmpty?: boolean;
  delta: { newUrls: string[]; continuedUrls: string[]; droppedUrls: string[] };
  volume: {
    name: string;
    currentCount: number;
    previousCount: number;
    currentNative: number;
    previousNative: number;
    unit: string;
  }[];
  stdout?: string;
};

type StatusPayload = {
  ok: boolean;
  enginePresent?: boolean;
  python?: string;
  config?: PublicConfig;
  policy?: Record<string, unknown>;
  error?: string;
};

type RunSummary = {
  id: string;
  status: string;
  createdAt: number;
  topic?: string;
  exitCode?: number | null;
  error?: string;
  argv?: string[];
  outputRelativePath?: string;
  reportUri?: string;
};

function runTopicLabel(r: RunSummary): string {
  if (r.topic?.trim()) return r.topic.trim();
  const argv = r.argv;
  if (!argv || argv.length < 3) return "—";
  const candidate = argv[2];
  return candidate.startsWith("-") ? "—" : candidate;
}

function formatRunWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Tool result for runResearch — model summarizes in the same turn after the run finishes. */
function buildRunCompleteToolResult(
  status: string,
  topic: string,
  stdout: string,
  reportUri?: string,
): string {
  if (status === "failed" || status === "cancelled") {
    const detail = stdout.trim() || "No output.";
    return `Research ${status} for topic "${topic}". ${detail.slice(0, 600)}`;
  }

  const report = tryParseAgentReport(stdout);
  if (report) {
    const nClusters = report.clusters?.length ?? 0;
    const nItems = report.results?.length ?? 0;
    const indexed = indexClustersForDisplay(report.clusters || [], report.results || [], {
      query: report.query,
    });
    const themes = indexed
      .slice(0, 3)
      .map((entry) => entry.cluster?.title?.trim())
      .filter(Boolean);
    return (
      `Research completed for "${report.query ?? topic}"` +
      (report.window_days ? ` (${report.window_days} days)` : "") +
      `. ${nClusters} clusters, ${nItems} items.` +
      (themes.length ? ` Top themes: ${themes.join("; ")}.` : "") +
      (reportUri ? ` Report file: ${reportUri}.` : "") +
      " Full report is in the Results panel — summarize 1–3 key findings for the user in plain language."
    );
  }

  const trimmed = stdout.trim();
  return trimmed
    ? `Research completed for "${topic}". ${trimmed.slice(0, 1200)}`
    : `Research completed for "${topic}" with no stdout.`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const raw = await response.text();
  let body: (T & { error?: string; ok?: boolean }) | null = null;
  if (raw.trim()) {
    try {
      body = JSON.parse(raw) as T & { error?: string; ok?: boolean };
    } catch {
      throw new Error(
        response.ok
          ? `Invalid JSON from ${url}`
          : `Request failed (${response.status}): ${raw.slice(0, 120) || response.statusText}`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})${raw ? `: ${raw.slice(0, 120)}` : ""}`,
    );
  }
  if (body == null) {
    throw new Error(`Empty response from ${url}`);
  }
  return body;
}

function StatusPill({
  state,
  label,
}: {
  state: "ready" | "busy" | "err" | "idle";
  label: string;
}) {
  return (
    <span className={`status-pill ${state === "idle" ? "" : state}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function App() {
  const guiRef = useRef<Last30DaysGuiAgentApi | null>(null);
  const runInFlightRef = useRef(false);
  const seenRunIdsRef = useRef<Set<string>>(new Set());
  const runsPollReadyRef = useRef(false);
  const [nav, setNav] = useState<NavId>("research");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Research form
  const [topic, setTopic] = useState("");
  const [depth, setDepth] = useState<"default" | "quick" | "deep">("quick");
  const [days, setDays] = useState(30);
  const [register, setRegister] = useState("default");
  const [emit, setEmit] = useState<"json" | "md" | "compact" | "html">("json");
  const [mock, setMock] = useState(false);
  const [hiringSignals, setHiringSignals] = useState(false);
  const [competitors, setCompetitors] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false);
  const [advanced, setAdvanced] = useState("");
  const [searchOverride, setSearchOverride] = useState("");

  // Run / results
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [resultText, setResultText] = useState("");
  const [activeReportUri, setActiveReportUri] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [drillTarget, setDrillTarget] = useState("1");

  // Watching
  const [watchingTopics, setWatchingTopics] = useState<WatchingTopicRow[]>([]);
  const [watchDraft, setWatchDraft] = useState("");
  const [watchCadence, setWatchCadence] = useState<"daily" | "weekly">("daily");
  const [selectedWatch, setSelectedWatch] = useState<string | null>(null);
  const [watchReport, setWatchReport] = useState<WatchReportPayload | null>(null);
  const [showProgress, setShowProgress] = useState(false);

  // Settings / first-use dialogs
  const [scKey, setScKey] = useState("");
  const [xquikKey, setXquikKey] = useState("");
  const [includeSources, setIncludeSources] = useState(
    "tiktok,instagram,youtube_comments,tiktok_comments,instagram_comments",
  );
  const [memoryDir, setMemoryDir] = useState("");
  const [storeEnabled, setStoreEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [doctorOut, setDoctorOut] = useState("");
  const [storeArgs, setStoreArgs] = useState("stats");
  const [briefArgs, setBriefArgs] = useState("show");
  const [settingsPowerOpen, setSettingsPowerOpen] = useState(false);

  const scRelay = Boolean(status?.config?.scrapecreatorsRelay?.configured);
  const xquikRelay = Boolean(status?.config?.xquikRelay?.configured);

  const refreshWatching = useCallback(async () => {
    try {
      const data = await fetchJson<{ topics: WatchingTopicRow[] }>(`${API}/watching`);
      setWatchingTopics(data.topics || []);
      return data.topics || [];
    } catch {
      setWatchingTopics([]);
      return [] as WatchingTopicRow[];
    }
  }, []);

  const loadWatchReport = useCallback(async (topicName: string) => {
    setSelectedWatch(topicName);
    try {
      const data = await fetchJson<WatchReportPayload>(
        `${API}/watching/report?topic=${encodeURIComponent(topicName)}`,
      );
      setWatchReport(data);
    } catch {
      setWatchReport(null);
    }
  }, []);

  const watchThisTopic = useCallback(
    async (name?: string): Promise<string> => {
      const topicName = (name || topic).trim();
      if (!topicName) return "Enter a topic first.";
      await fetchJson(`${API}/watching`, {
        method: "POST",
        body: JSON.stringify({
          topic: topicName,
          cadence: "daily",
          stdout: resultText || undefined,
          runId: activeRunId || undefined,
        }),
      });
      await refreshWatching();
      setNav("watching");
      await loadWatchReport(topicName);
      return `Watching “${topicName}”.`;
    },
    [topic, resultText, activeRunId, refreshWatching, loadWatchReport],
  );

  const refreshStatus = useCallback(async () => {
    const data = await fetchJson<StatusPayload>(`${API}/status`);
    setStatus(data);
    if (data.config?.includeSources) setIncludeSources(data.config.includeSources);
    if (data.config?.memoryDir) setMemoryDir(data.config.memoryDir);
    if (typeof data.config?.store === "boolean") setStoreEnabled(data.config.store);
    if (typeof data.config?.register === "string" && data.config.register) {
      setRegister(data.config.register);
    }
    if (data.config && !data.config.setupComplete && !onboardingDismissed) {
      setOnboardingOpen(true);
    }
  }, [onboardingDismissed]);

  const refreshRuns = useCallback(async () => {
    const data = await fetchJson<{ runs: RunSummary[] }>(`${API}/runs`);
    setRuns(data.runs || []);
    return data.runs || [];
  }, []);

  useEffect(() => {
    void refreshStatus().catch((err: Error) => {
      // During box boot the API may return empty bodies — avoid scary JSON parse errors.
      const msg = err.message.includes("JSON") || err.message.includes("Empty response")
        ? "Joshu API is starting — retry in a moment."
        : err.message;
      setError(msg);
    });
    void refreshRuns()
      .then((initial) => {
        for (const r of initial) seenRunIdsRef.current.add(r.id);
        runsPollReadyRef.current = true;
      })
      .catch(() => {
        runsPollReadyRef.current = true;
      });
    void refreshWatching().catch(() => undefined);
  }, [refreshStatus, refreshRuns, refreshWatching]);

  const attachRunStream = useCallback((runId: string): Promise<string> => {
    setActiveRunId(runId);
    setLogLines([]);
    setResultText("");
    setActiveReportUri(null);
    setBusy(true);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        setBusy(false);
        runInFlightRef.current = false;
      void fetchJson<{
        run: {
          stdout: string;
          status: string;
          error?: string;
          argv?: string[];
          outputRelativePath?: string;
        };
      }>(`${API}/runs/${runId}`)
        .then((full) => {
          const stdout = full.run.stdout || full.run.error || "";
          setResultText(stdout);
          void refreshRuns();
          const label = runTopicLabel({
            id: runId,
            status: full.run.status,
            createdAt: 0,
            argv: full.run.argv,
          });
          const reportUri = full.run.outputRelativePath
            ? `joshu://${full.run.outputRelativePath.replace(/^\/+/, "")}`
            : undefined;
          setActiveReportUri(reportUri ?? null);
          void refreshWatching();
          resolve(buildRunCompleteToolResult(full.run.status, label, stdout, reportUri));
        })
          .catch((err: Error) => {
            void refreshRuns();
            reject(err);
          });
      };

      const es = new EventSource(`${API}/runs/${runId}/events`);
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data) as {
            type: string;
            line?: string;
            chunk?: string;
            status?: string;
            exitCode?: number | null;
            error?: string;
          };
          if (payload.type === "stderr" && payload.line != null) {
            setLogLines((prev) => appendSanitizedLog(prev, payload.line!));
          }
          if (payload.type === "stdout" && payload.chunk) {
            setResultText((prev) => prev + payload.chunk);
          }
          if (payload.type === "done") {
            es.close();
            settle();
          }
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        es.close();
        // Browsers often fire error when the SSE stream ends after done — still load stdout.
        settle();
      };
    });
  }, [refreshRuns, refreshWatching]);

  const openHistoricalRun = useCallback(async (runId: string) => {
    setError(null);
    setActiveRunId(runId);
    setBusy(false);
    try {
      const full = await fetchJson<{
        run: { stdout: string; stderrLines?: string[]; error?: string };
      }>(`${API}/runs/${runId}`);
      setResultText(full.run.stdout || full.run.error || "");
      setLogLines(
        (full.run.stderrLines || []).flatMap((line) => {
          const cleaned = sanitizeLogLine(line);
          return cleaned == null ? [] : [cleaned];
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Pick up runs started outside the UI (chat invoke, headless invoke, duplicate tab).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!runsPollReadyRef.current) return;
      void refreshRuns()
        .then((next) => {
          for (const r of next) {
            if (seenRunIdsRef.current.has(r.id)) continue;
            seenRunIdsRef.current.add(r.id);
            const label = runTopicLabel(r);
            if (label !== "—") setTopic(label);
            if (r.status === "running" || r.status === "queued") {
              attachRunStream(r.id);
            } else if (nav === "research") {
              void openHistoricalRun(r.id);
            }
            break;
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [attachRunStream, nav, openHistoricalRun, refreshRuns]);

  const startResearch = async (overrides?: {
    topic?: string;
    days?: number;
    depth?: "default" | "quick" | "deep";
    mock?: boolean;
  }): Promise<string | null> => {
    if (runInFlightRef.current || busy) return null;
    setError(null);
    const effectiveTopic = (overrides?.topic ?? topic).trim();
    const effectiveMock = overrides?.mock ?? mock;
    if (!effectiveTopic && !effectiveMock) {
      setError("Enter a topic");
      return null;
    }
    if (overrides?.topic) setTopic(overrides.topic);
    if (overrides?.days) setDays(overrides.days);
    if (overrides?.depth) setDepth(overrides.depth);
    if (overrides?.mock != null) setMock(overrides.mock);
    setNav("research");
    runInFlightRef.current = true;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        topic: effectiveTopic || "mock topic",
        emit: "json",
        jsonProfile: "agent",
        days: overrides?.days ?? days,
        mock: effectiveMock,
        hiringSignals,
        deepResearch,
        search: searchOverride || undefined,
        quick: (overrides?.depth ?? depth) === "quick",
        deep: (overrides?.depth ?? depth) === "deep",
      };
      // Writing style shapes the saved .md (JSON Results UI stays relevance-sorted).
      if (register && register !== "default") body.register = register;
      if (competitors) body.competitors = true;
      if (advanced.trim()) {
        body.extraArgs = advanced.trim().split(/\s+/);
      }
      const data = await fetchJson<{ runId: string }>(`${API}/research`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      seenRunIdsRef.current.add(data.runId);
      return attachRunStream(data.runId);
    } catch (err) {
      runInFlightRef.current = false;
      setBusy(false);
      setError((err as Error).message);
      throw err;
    }
  };

  const runDrill = async () => {
    setError(null);
    setBusy(true);
    try {
      const data = await fetchJson<{ runId: string }>(`${API}/drill`, {
        method: "POST",
        body: JSON.stringify({ drill: drillTarget, emit, mock }),
      });
      attachRunStream(data.runId);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };

  const cancelActive = async () => {
    if (!activeRunId) return;
    await fetchJson(`${API}/runs/${activeRunId}/cancel`, { method: "POST" });
  };

  const saveSetup = async (tier: "recommended" | "everything" | "custom") => {
    setError(null);
    try {
      await fetchJson(`${API}/setup`, {
        method: "POST",
        body: JSON.stringify({
          scrapecreatorsApiKey: scKey || undefined,
          tier: tier === "custom" ? undefined : tier,
          includeSources: tier === "custom" ? includeSources : undefined,
          markComplete: true,
        }),
      });
      setScKey("");
      setOnboardingOpen(false);
      setOnboardingDismissed(false);
      await refreshStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveSettings = async () => {
    setError(null);
    try {
      await fetchJson(`${API}/config`, {
        method: "PUT",
        body: JSON.stringify({
          scrapecreatorsApiKey: scKey || undefined,
          xquikApiKey: xquikKey || undefined,
          includeSources,
          memoryDir: memoryDir || undefined,
          store: storeEnabled,
          register,
          setupComplete: true,
        }),
      });
      setScKey("");
      setXquikKey("");
      setOnboardingOpen(false);
      setOnboardingDismissed(false);
      await refreshStatus();
      setSettingsOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadDoctor = async (mode: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<{ stdout: string; stderr?: string[] }>(
        `${API}/doctor?mode=${encodeURIComponent(mode)}`,
      );
      setDoctorOut(data.stdout || (data.stderr || []).join("\n"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const engineLabel = useMemo(() => {
    if (!status) return "Loading…";
    if (!status.enginePresent) return "Engine missing";
    return "Ready";
  }, [status]);

  guiRef.current = {
    getGuiSnapshot: () => ({
      activeView: nav,
      topic,
      activeRunId,
      runStatus: busy ? "running" : activeRunId ? "idle" : null,
      resultPreview: resultText.slice(0, 600),
      recentRuns: runs.slice(0, 5).map((r) => ({
        id: r.id,
        status: r.status,
        topic: runTopicLabel(r),
        when: formatRunWhen(r.createdAt),
      })),
      engineReady: Boolean(status?.enginePresent),
    }),
    runResearch: async (args) => {
      const depthRaw = typeof args.depth === "string" ? args.depth : undefined;
      const depthNorm =
        depthRaw === "quick" || depthRaw === "deep" || depthRaw === "default"
          ? depthRaw
          : depthRaw === "standard"
            ? "default"
            : undefined;
      if (runInFlightRef.current || busy) {
        return "Research already in progress — wait for it to finish or call cancelRun.";
      }
      const summary = await startResearch({
        topic: typeof args.topic === "string" ? args.topic : undefined,
        days: typeof args.days === "number" ? args.days : undefined,
        depth: depthNorm,
        mock: args.mock === true,
      });
      if (!summary) {
        return "Could not start research — enter a topic or use mock.";
      }
      return summary;
    },
    cancelRun: async () => {
      await cancelActive();
      return "Cancel requested.";
    },
    openRun: async (runId) => {
      await openHistoricalRun(runId);
      return `Opened run ${runId}.`;
    },
    openSettings: () => {
      setOnboardingOpen(false);
      setSettingsOpen(true);
      return "Settings opened.";
    },
    runDoctor: async () => {
      setSettingsOpen(true);
      await loadDoctor("json");
      return "Doctor json run complete.";
    },
    refreshRuns: async () => {
      await refreshRuns();
      return "Runs refreshed.";
    },
    openWatching: () => {
      setNav("watching");
      void refreshWatching();
      return "Watching opened.";
    },
    watchThisTopic: async (args) => watchThisTopic(args.topic),
  };

  const navItems: { id: NavId; label: string }[] = [
    { id: "research", label: "Research" },
    { id: "watching", label: "Watching" },
  ];

  const openSettings = () => {
    setOnboardingOpen(false);
    setSettingsOpen(true);
  };

  return (
    <JoshuMultimodalApp
      manifest={LAST30DAYS_MANIFEST}
      guiRef={guiRef}
      createGuiActions={createLast30DaysGuiActions}
      guiReadableDescription="Current last30days UI — activeView, topic, runs, results preview"
      chatTitle="last30days"
    >
    <div className="app-shell">
      <aside className="nav">
        <div className="brand">
          <p className="eyebrow">Joshu</p>
          <h1>last30days</h1>
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-btn ${nav === item.id ? "active" : ""}`}
            onClick={() => setNav(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="nav-footer">
          <StatusPill
            state={busy ? "busy" : status?.enginePresent ? "ready" : "err"}
            label={busy ? "Running…" : engineLabel}
          />
          <button
            type="button"
            className="gear-icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={openSettings}
          >
            ⚙
          </button>
        </div>
      </aside>

      <main className="main">
        {error ? <div className="error-box">{error}</div> : null}

        {nav === "research" && (
          <section className="research-stack">
            <div className="details-grid">
              <div className="panel form-grid">
                <div className="panel-head">
                  <p className="eyebrow">Ask</p>
                </div>
                <label className="topic-field">
                  Topic
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="A company, product, person, or “A vs B”"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void startResearch();
                      }
                    }}
                  />
                </label>
                <div className="segmented" role="group" aria-label="Lookback window">
                  <button
                    type="button"
                    className={`chip ${days === 7 ? "on" : ""}`}
                    onClick={() => setDays(7)}
                  >
                    Last 7 days
                  </button>
                  <button
                    type="button"
                    className={`chip ${days === 30 ? "on" : ""}`}
                    onClick={() => setDays(30)}
                  >
                    Last 30 days
                  </button>
                </div>
                {busy ? (
                  <p className="run-status-line">
                    Searching Reddit, HN, X, and the web…
                    <button
                      type="button"
                      className="btn compact ghost"
                      onClick={() => setShowProgress((v) => !v)}
                    >
                      {showProgress ? "Hide progress" : "Show progress"}
                    </button>
                  </p>
                ) : null}
                <details className="advanced">
                  <summary>More options</summary>
                  <div className="advanced-body">
                    <label>
                      Depth
                      <select value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
                        <option value="quick">Simple</option>
                        <option value="default">Thorough</option>
                        <option value="deep">Deep</option>
                      </select>
                    </label>
                    <label>
                      Writing style
                      <select value={register} onChange={(e) => setRegister(e.target.value)}>
                        <option value="default">Default</option>
                        <option value="exec">Executive</option>
                        <option value="dev">Technical</option>
                        <option value="creator">Creator</option>
                        <option value="eli5">Plain language</option>
                      </select>
                    </label>
                    <p className="hint">Applies to the saved markdown brief, not the Results cards.</p>
                    <div className="chips">
                      <button type="button" className={`chip ${mock ? "on" : ""}`} onClick={() => setMock((v) => !v)}>
                        Offline test
                      </button>
                      <button
                        type="button"
                        className={`chip ${hiringSignals ? "on" : ""}`}
                        onClick={() => setHiringSignals((v) => !v)}
                      >
                        Hiring signals
                      </button>
                      <button
                        type="button"
                        className={`chip ${competitors ? "on" : ""}`}
                        onClick={() => setCompetitors((v) => !v)}
                      >
                        Competitors
                      </button>
                      <button
                        type="button"
                        className={`chip ${deepResearch ? "on" : ""}`}
                        onClick={() => setDeepResearch((v) => !v)}
                      >
                        Extra web pass
                      </button>
                    </div>
                    <label>
                      Source override
                      <input
                        value={searchOverride}
                        onChange={(e) => setSearchOverride(e.target.value)}
                        placeholder="reddit,youtube,hn,web,x"
                      />
                    </label>
                    <label>
                      Extra flags
                      <input
                        value={advanced}
                        onChange={(e) => setAdvanced(e.target.value)}
                        placeholder="rarely needed"
                      />
                    </label>
                  </div>
                </details>
                <div className="actions-row">
                  <p className="hint">Enter to run</p>
                  <div className="row">
                    <button type="button" className="btn" disabled={!busy} onClick={() => void cancelActive()}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary" disabled={busy} onClick={() => void startResearch()}>
                      {busy ? "Running…" : "Research"}
                    </button>
                  </div>
                </div>
              </div>
              {showProgress || (!busy && logLines.length > 0) ? (
              <div className="panel log-panel">
                <div className="panel-head">
                  <p className="eyebrow">Progress</p>
                  {busy ? <span className="run-status running">live</span> : null}
                </div>
                <div className={`log-box ${logLines.length ? "" : "is-empty"}`}>
                  {logLines.join("\n") || "Waiting for a run…"}
                </div>
              </div>
              ) : (
                <div className="panel log-panel is-quiet">
                  <p className="hint">Results appear below after a run.</p>
                </div>
              )}
            </div>

            <div className="results-layout">
              <div className="panel form-grid results-main">
                <div className="panel-head">
                  <p className="eyebrow">Results</p>
                  {activeReportUri ? (
                    <p className="report-uri" title="Open from Joshu Files on the desktop">
                      Saved report: <code>{activeReportUri}</code>
                    </p>
                  ) : null}
                </div>
                <ResearchReportView
                  text={resultText}
                  onWatchTopic={() => void watchThisTopic()}
                  alreadyWatched={watchingTopics.some(
                    (t) => t.name.trim().toLowerCase() === topic.trim().toLowerCase(),
                  )}
                  watchLabel={
                    watchingTopics.find(
                      (t) => t.name.trim().toLowerCase() === topic.trim().toLowerCase(),
                    )?.status.label
                  }
                />
                <details className="advanced">
                  <summary>More on this result</summary>
                  <div className="advanced-body">
                    <label>
                      Drill into a cluster
                      <input value={drillTarget} onChange={(e) => setDrillTarget(e.target.value)} />
                    </label>
                    <div className="row">
                      <button type="button" className="btn compact" disabled={busy} onClick={() => void runDrill()}>
                        Drill
                      </button>
                      <button
                        type="button"
                        className="btn compact ghost"
                        onClick={() => {
                          void fetchJson(`${API}/verify-freshness`, {
                            method: "POST",
                            body: JSON.stringify({ mock }),
                          }).then(
                            (data: { runId?: string }) => data.runId && attachRunStream(data.runId),
                          );
                        }}
                      >
                        Recheck freshness
                      </button>
                    </div>
                  </div>
                </details>
              </div>

              <div className="panel form-grid runs-rail">
                <div className="panel-head">
                  <p className="eyebrow">History</p>
                </div>
                {runs.length === 0 ? (
                  <p className="runs-empty">No runs yet.</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Topic</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 10).map((r) => (
                        <tr key={r.id}>
                          <td>{formatRunWhen(r.createdAt)}</td>
                          <td className="run-topic">{runTopicLabel(r)}</td>
                          <td>
                            <span className={`run-status ${r.status}`}>{r.status}</span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn compact"
                              title={`Run ${r.id}`}
                              onClick={() => void openHistoricalRun(r.id)}
                            >
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>
        )}

        {nav === "watching" && (
          <section className="watching-stack">
            <div className="panel form-grid">
              <div className="panel-head">
                <p className="eyebrow">Watching</p>
                <button
                  type="button"
                  className="btn compact"
                  disabled={busy || watchingTopics.length === 0}
                  onClick={() => {
                    void fetchJson<{ runIds?: string[] }>(`${API}/watching/run-all`, {
                      method: "POST",
                      body: "{}",
                    }).then((d) => {
                      const first = d.runIds?.[0];
                      if (first) attachRunStream(first);
                      void refreshWatching();
                    });
                  }}
                >
                  Check all now
                </button>
              </div>
              <div className="watch-add">
                <label className="topic-field">
                  Add a topic
                  <input
                    value={watchDraft}
                    onChange={(e) => setWatchDraft(e.target.value)}
                    placeholder="Company or product to track"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const name = watchDraft.trim();
                        if (!name) return;
                        void fetchJson(`${API}/watching`, {
                          method: "POST",
                          body: JSON.stringify({ topic: name, cadence: watchCadence }),
                        }).then(() => {
                          setWatchDraft("");
                          void refreshWatching();
                        });
                      }
                    }}
                  />
                </label>
                <div className="segmented">
                  <button
                    type="button"
                    className={`chip ${watchCadence === "daily" ? "on" : ""}`}
                    onClick={() => setWatchCadence("daily")}
                  >
                    Daily
                  </button>
                  <button
                    type="button"
                    className={`chip ${watchCadence === "weekly" ? "on" : ""}`}
                    onClick={() => setWatchCadence("weekly")}
                  >
                    Weekly
                  </button>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    const name = watchDraft.trim();
                    if (!name) return;
                    void fetchJson(`${API}/watching`, {
                      method: "POST",
                      body: JSON.stringify({ topic: name, cadence: watchCadence }),
                    }).then(() => {
                      setWatchDraft("");
                      void refreshWatching();
                    });
                  }}
                >
                  Watch
                </button>
              </div>
              {watchingTopics.length === 0 ? (
                <div className="empty-state">
                  <p>Watch a topic after a research run, or add one here.</p>
                  <p className="hint">Watches re-check on a schedule and flag what is above average.</p>
                </div>
              ) : (
                <table className="table watch-table">
                  <thead>
                    <tr>
                      <th>Topic</th>
                      <th>Cadence</th>
                      <th>Last checked</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {watchingTopics.map((row) => (
                      <tr
                        key={row.name}
                        className={selectedWatch === row.name ? "is-selected" : ""}
                        onClick={() => void loadWatchReport(row.name)}
                      >
                        <td>{row.name}</td>
                        <td>{row.cadence === "weekly" ? "Weekly" : "Daily"}</td>
                        <td>
                          {row.lastCheckedAt
                            ? formatRunWhen(Date.parse(row.lastCheckedAt) || 0)
                            : "—"}
                        </td>
                        <td>
                          <span className={`trend-pill kind-${row.status.kind}`}>
                            {row.status.label}
                          </span>
                        </td>
                        <td>
                          <div className="row">
                            <button
                              type="button"
                              className="btn compact"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void fetchJson<{ runId: string }>(`${API}/watching/run`, {
                                  method: "POST",
                                  body: JSON.stringify({ topic: row.name }),
                                }).then((d) => {
                                  if (d.runId) attachRunStream(d.runId);
                                });
                              }}
                            >
                              Check now
                            </button>
                            <button
                              type="button"
                              className="btn compact ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                void fetchJson(`${API}/watching`, {
                                  method: "DELETE",
                                  body: JSON.stringify({ topic: row.name }),
                                }).then(() => {
                                  if (selectedWatch === row.name) {
                                    setSelectedWatch(null);
                                    setWatchReport(null);
                                  }
                                  void refreshWatching();
                                });
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {watchReport ? (
              <div className="panel form-grid">
                <div className="panel-head">
                  <p className="eyebrow">Watch report</p>
                  <span className={`trend-pill kind-${watchReport.trend.kind}`}>
                    {watchReport.trend.label}
                  </span>
                </div>
                {watchReport.quietEmpty ? (
                  <p className="hint">Nothing new this window.</p>
                ) : (
                  <>
                    <div>
                      <h3>What’s new</h3>
                      {watchReport.delta.newUrls.length === 0 ? (
                        <p className="hint">No new stories.</p>
                      ) : (
                        <ul className="item-list">
                          {watchReport.delta.newUrls.slice(0, 12).map((url) => (
                            <li key={url}>
                              <a href={url} target="_blank" rel="noreferrer">
                                {url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h3>What fell off</h3>
                      {watchReport.delta.droppedUrls.length === 0 ? (
                        <p className="hint">Nothing dropped.</p>
                      ) : (
                        <ul className="item-list">
                          {watchReport.delta.droppedUrls.slice(0, 12).map((url) => (
                            <li key={url}>
                              <a href={url} target="_blank" rel="noreferrer">
                                {url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h3>Volume by source</h3>
                      <div className="source-strip">
                        {watchReport.volume.map((v) => (
                          <span key={v.name} className="source-chip">
                            {v.name}
                            <strong>
                              {v.currentCount} / {formatCompactCount(v.currentNative)} {v.unit}
                            </strong>
                            <span className="hint">
                              was {v.previousCount} / {formatCompactCount(v.previousNative)}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                    {watchReport.stdout ? (
                      <details className="advanced">
                        <summary>This window</summary>
                        <ResearchReportView text={watchReport.stdout} />
                      </details>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </section>
        )}

        {onboardingOpen && !settingsOpen ? (
          <div className="modal-backdrop" role="presentation" onClick={() => undefined}>
            <div
              className="modal-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="onboarding-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2 id="onboarding-title">Welcome — set up last30days</h2>
              </div>
              <div className="form-grid">
                <p className="hint">
                  {scRelay
                    ? "Social sources use Joshu’s shared connection. Pick how much to include."
                    : "Paste your ScrapeCreators API key and pick how much to include. You can change this later in Settings."}
                </p>
                {scRelay ? null : (
                <label>
                  ScrapeCreators API key
                  <input
                    type="password"
                    value={scKey}
                    onChange={(e) => setScKey(e.target.value)}
                    placeholder={
                      status?.config?.scrapecreators?.present &&
                      status.config.scrapecreators.last4
                        ? `saved …${status.config.scrapecreators.last4}`
                        : "scrape_creators_…"
                    }
                  />
                </label>
                )}
                <label>
                  Extra sources
                  <input value={includeSources} onChange={(e) => setIncludeSources(e.target.value)} />
                </label>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void saveSetup("recommended")}
                  >
                    Save recommended
                  </button>
                  <button type="button" className="btn" onClick={() => void saveSetup("everything")}>
                    All social
                  </button>
                  <button type="button" className="btn" onClick={() => void saveSetup("custom")}>
                    Save custom
                  </button>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setOnboardingDismissed(true);
                      setOnboardingOpen(false);
                    }}
                  >
                    Skip for now
                  </button>
                  <button type="button" className="btn" onClick={openSettings}>
                    Open Settings…
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {settingsOpen ? (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={() => setSettingsOpen(false)}
          >
            <div
              className="modal-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2 id="settings-title">Settings</h2>
                <button
                  type="button"
                  className="gear-icon-btn"
                  aria-label="Close settings"
                  onClick={() => setSettingsOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="form-grid">
                {scRelay && xquikRelay ? (
                  <p className="hint">Social and X search use Joshu — no API keys on this box.</p>
                ) : scRelay ? (
                  <p className="hint">Social sources use Joshu — no ScrapeCreators key on this box.</p>
                ) : xquikRelay ? (
                  <p className="hint">X search uses Joshu — no Xquik key on this box.</p>
                ) : (
                  <p className="hint">
                    No browser cookies or yt-dlp. Paste keys below for social and X search.
                  </p>
                )}
                {!scRelay ? (
                <label>
                  ScrapeCreators API key (leave blank to keep saved)
                  <input type="password" value={scKey} onChange={(e) => setScKey(e.target.value)} />
                </label>
                ) : null}
                {!xquikRelay ? (
                <label>
                  Xquik API key for X search (leave blank to keep saved)
                  <input type="password" value={xquikKey} onChange={(e) => setXquikKey(e.target.value)} />
                </label>
                ) : null}
                <label>
                  Extra sources
                  <input value={includeSources} onChange={(e) => setIncludeSources(e.target.value)} />
                </label>
                <label style={{ flexDirection: "row", alignItems: "center", gap: "0.6rem" }}>
                  <input
                    type="checkbox"
                    checked={storeEnabled}
                    onChange={(e) => setStoreEnabled(e.target.checked)}
                  />
                  Save research history
                </label>
                <button
                  type="button"
                  className="btn compact"
                  disabled={busy}
                  onClick={() => void loadDoctor("json")}
                >
                  Check connections
                </button>
                {doctorOut ? <pre className="result-box">{doctorOut}</pre> : null}
                <details className="advanced" open={settingsPowerOpen} onToggle={(e) => setSettingsPowerOpen((e.target as HTMLDetailsElement).open)}>
                  <summary>Power user</summary>
                  <div className="advanced-body">
                    <label>
                      Memory folder
                      <input value={memoryDir} onChange={(e) => setMemoryDir(e.target.value)} />
                    </label>
                    <label>
                      Writing style default
                      <select value={register} onChange={(e) => setRegister(e.target.value)}>
                        <option value="default">Default</option>
                        <option value="exec">Executive</option>
                        <option value="dev">Technical</option>
                        <option value="creator">Creator</option>
                        <option value="eli5">Plain language</option>
                      </select>
                    </label>
                    <label>
                      Store command
                      <input value={storeArgs} onChange={(e) => setStoreArgs(e.target.value)} />
                    </label>
                    <button
                      type="button"
                      className="btn compact"
                      onClick={() => {
                        void fetchJson<{ stdout: string; stderr: string }>(`${API}/store`, {
                          method: "POST",
                          body: JSON.stringify({ args: storeArgs.trim().split(/\s+/).filter(Boolean) }),
                        }).then((d) => setDoctorOut(`${d.stdout}\n${d.stderr}`));
                      }}
                    >
                      Run store command
                    </button>
                    <label>
                      Briefing command
                      <input value={briefArgs} onChange={(e) => setBriefArgs(e.target.value)} />
                    </label>
                    <button
                      type="button"
                      className="btn compact"
                      onClick={() => {
                        void fetchJson<{ stdout: string; stderr: string }>(`${API}/briefings`, {
                          method: "POST",
                          body: JSON.stringify({ args: briefArgs.trim().split(/\s+/).filter(Boolean) }),
                        }).then((d) => setDoctorOut(`${d.stdout}\n${d.stderr}`));
                      }}
                    >
                      Run briefing command
                    </button>
                  </div>
                </details>
                {!status?.config?.setupComplete ? (
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setSettingsOpen(false);
                        setOnboardingOpen(true);
                      }}
                    >
                      First-time setup…
                    </button>
                  </div>
                ) : null}
                <div className="row">
                  <button type="button" className="btn primary" onClick={() => void saveSettings()}>
                    Save settings
                  </button>
                  <button type="button" className="btn" onClick={() => void refreshStatus()}>
                    Reload
                  </button>
                  <button type="button" className="btn" onClick={() => setSettingsOpen(false)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
    </JoshuMultimodalApp>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
