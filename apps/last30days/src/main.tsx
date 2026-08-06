import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

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

type AgentCluster = {
  title?: string;
  summary?: string;
  sources?: string[];
  engagement_total?: number;
};

type AgentResultItem = {
  candidate_id?: string;
  title?: string;
  summary?: string;
  url?: string;
  source?: string;
  published_at?: string;
  cluster?: number;
  engagement?: Record<string, number>;
  relevance_score?: number;
};

type AgentReport = {
  query?: string;
  window_days?: number;
  generated_at?: string;
  clusters?: AgentCluster[];
  results?: AgentResultItem[];
  source_status?: Record<string, string>;
  schema_version?: string;
};

function sourceIssuesFromStatus(status?: Record<string, string>): string[] {
  if (!status) return [];
  return Object.entries(status)
    .filter(([, value]) => value && value !== "ok")
    .map(([name, value]) => `${name}: ${value}`);
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

function tryParseAgentReport(text: string): AgentReport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as AgentReport;
    if (!Array.isArray(obj.clusters) && !Array.isArray(obj.results)) return null;
    return obj;
  } catch {
    return null;
  }
}

type IndexedCluster = {
  cluster: AgentCluster;
  /** Original cluster index referenced by result items. */
  idx: number;
  memberCount: number;
};

/** Display clusters by engagement; keep original idx for result membership. */
function indexClustersForDisplay(
  clusters: AgentCluster[],
  items: AgentResultItem[],
): IndexedCluster[] {
  return clusters
    .map((cluster, idx) => ({
      cluster,
      idx,
      memberCount: items.filter((item) => item.cluster === idx).length,
    }))
    .sort((a, b) => {
      const engA = a.cluster.engagement_total ?? 0;
      const engB = b.cluster.engagement_total ?? 0;
      if (engB !== engA) return engB - engA;
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      return a.idx - b.idx;
    });
}

function membersForCluster(
  items: AgentResultItem[],
  clusterIdx: number,
  limit = 6,
): AgentResultItem[] {
  return items
    .filter((item) => item.cluster === clusterIdx)
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, limit);
}

function sourceCounts(report: AgentReport): { name: string; count: number; status?: string }[] {
  const counts = new Map<string, number>();
  for (const item of report.results || []) {
    const src = (item.source || "unknown").toLowerCase();
    counts.set(src, (counts.get(src) || 0) + 1);
  }
  const names = new Set<string>([...counts.keys(), ...Object.keys(report.source_status || {})]);
  return [...names]
    .sort()
    .map((name) => ({
      name,
      count: counts.get(name) || 0,
      status: report.source_status?.[name],
    }));
}

function ResearchReportView({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const report = useMemo(() => tryParseAgentReport(text), [text]);
  const mdAlerts = useMemo(
    () => (report ? null : extractMdReportAlerts(text)),
    [report, text],
  );
  // Hooks must run unconditionally — opening a saved JSON run used to crash here.
  const indexedClusters = useMemo(
    () => indexClustersForDisplay(report?.clusters || [], report?.results || []),
    [report],
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
  const counts = sourceCounts(report);
  const issues = sourceIssuesFromStatus(report.source_status);
  const missingExpected = !counts.some((c) => c.name === "youtube" && c.count > 0);

  return (
    <div className="result-stack">
      <div className="report-meta">
        <div>
          <p className="eyebrow">Brief</p>
          <h2 className="report-title">{report.query || "Research"}</h2>
          <p className="hint">
            {report.window_days ? `${report.window_days}d window` : "window n/a"}
            {report.generated_at
              ? ` · ${new Date(report.generated_at).toLocaleString()}`
              : ""}
            {` · ${clusters.length} clusters (${groupedCount} grouped) · ${items.length} items`}
            {" · sorted by engagement"}
          </p>
        </div>
        <button type="button" className="btn compact ghost" onClick={() => setShowRaw(true)}>
          Raw JSON
        </button>
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
              <strong>{c.count}</strong>
            </span>
          ))
        )}
      </div>

      {missingExpected ? (
        <p className="hint policy-hint">
          X is unavailable in this Joshu app (no cookies / XAI / Xquik). YouTube runs via ScrapeCreators
          when the planner includes it — try Depth <strong>Default</strong> or{" "}
          <strong>Deep</strong>, or set{" "}
          <code>--search youtube,reddit,hn,web,tiktok,instagram</code> under Advanced.
        </p>
      ) : null}

      <div className="cluster-list">
        {indexedClusters.map(({ cluster, idx, memberCount }, displayRank) => {
          const members = membersForCluster(items, idx);
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
                  {typeof cluster.engagement_total === "number" ? (
                    <span className="engagement">{cluster.engagement_total.toLocaleString()} eng</span>
                  ) : null}
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

type NavId =
  | "research"
  | "watchlist"
  | "store"
  | "briefings"
  | "doctor";

type PublicConfig = {
  setupComplete?: boolean;
  includeSources?: string;
  excludeSources?: string;
  memoryDir?: string;
  store?: boolean;
  register?: string;
  scrapecreators?: { present: boolean; last4?: string; relay?: boolean };
  scrapecreatorsRelay?: { mode?: string; configured?: boolean };
  policy?: Record<string, unknown>;
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
  exitCode?: number | null;
  error?: string;
  argv?: string[];
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: string; ok?: boolean };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [drillTarget, setDrillTarget] = useState("1");

  // Companions
  const [companionOut, setCompanionOut] = useState("");
  const [watchArgs, setWatchArgs] = useState("list");
  const [storeArgs, setStoreArgs] = useState("stats");
  const [briefArgs, setBriefArgs] = useState("show");
  const [doctorOut, setDoctorOut] = useState("");

  // Settings / first-use dialogs
  const [scKey, setScKey] = useState("");
  const [includeSources, setIncludeSources] = useState(
    "tiktok,instagram,youtube_comments,tiktok_comments,instagram_comments",
  );
  const [memoryDir, setMemoryDir] = useState("");
  const [storeEnabled, setStoreEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const scRelay = Boolean(status?.config?.scrapecreatorsRelay?.configured);

  const refreshStatus = useCallback(async () => {
    const data = await fetchJson<StatusPayload>(`${API}/status`);
    setStatus(data);
    if (data.config?.includeSources) setIncludeSources(data.config.includeSources);
    if (data.config?.memoryDir) setMemoryDir(data.config.memoryDir);
    if (typeof data.config?.store === "boolean") setStoreEnabled(data.config.store);
    if (data.config && !data.config.setupComplete && !onboardingDismissed) {
      setOnboardingOpen(true);
    }
  }, [onboardingDismissed]);

  const refreshRuns = useCallback(async () => {
    const data = await fetchJson<{ runs: RunSummary[] }>(`${API}/runs`);
    setRuns(data.runs || []);
  }, []);

  useEffect(() => {
    void refreshStatus().catch((err: Error) => setError(err.message));
    void refreshRuns().catch(() => undefined);
  }, [refreshStatus, refreshRuns]);

  const attachRunStream = useCallback((runId: string) => {
    setActiveRunId(runId);
    setLogLines([]);
    setResultText("");
    setBusy(true);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      setBusy(false);
      void fetchJson<{ run: { stdout: string; status: string; error?: string } }>(
        `${API}/runs/${runId}`,
      )
        .then((full) => {
          setResultText(full.run.stdout || full.run.error || "");
          void refreshRuns();
        })
        .catch(() => {
          void refreshRuns();
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
  }, [refreshRuns]);

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

  const startResearch = async () => {
    setError(null);
    if (!topic.trim() && !mock) {
      setError("Enter a topic");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        topic: topic.trim() || "mock topic",
        // GUI Results panel expects structured agent JSON, not Hermes markdown envelope.
        emit: "json",
        jsonProfile: "agent",
        register,
        days,
        mock,
        hiringSignals,
        deepResearch,
        search: searchOverride || undefined,
        quick: depth === "quick",
        deep: depth === "deep",
      };
      if (competitors) body.competitors = true;
      if (advanced.trim()) {
        body.extraArgs = advanced.trim().split(/\s+/);
      }
      const data = await fetchJson<{ runId: string }>(`${API}/research`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      attachRunStream(data.runId);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
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
          includeSources,
          memoryDir: memoryDir || undefined,
          store: storeEnabled,
          register,
          setupComplete: true,
        }),
      });
      setScKey("");
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

  const navItems: { id: NavId; label: string }[] = [
    { id: "research", label: "Research" },
    { id: "watchlist", label: "Watchlist" },
    { id: "store", label: "Store" },
    { id: "briefings", label: "Briefings" },
    { id: "doctor", label: "Doctor" },
  ];

  const openSettings = () => {
    setOnboardingOpen(false);
    setSettingsOpen(true);
  };

  return (
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
                  <p className="eyebrow">Query</p>
                </div>
                <label className="topic-field">
                  Topic
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="OpenAI Codex / Peter Steinberger / …"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void startResearch();
                      }
                    }}
                  />
                </label>
                <div className="form-grid four">
                  <label>
                    Depth
                    <select value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
                      <option value="quick">Quick</option>
                      <option value="default">Default</option>
                      <option value="deep">Deep</option>
                    </select>
                  </label>
                  <label>
                    Days
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value) || 30)}
                    />
                  </label>
                  <label>
                    Register
                    <select value={register} onChange={(e) => setRegister(e.target.value)}>
                      <option value="default">default</option>
                      <option value="exec">exec</option>
                      <option value="dev">dev</option>
                      <option value="creator">creator</option>
                      <option value="eli5">eli5</option>
                    </select>
                  </label>
                  <p className="hint emit-hint">
                    Results always use <strong>json (agent)</strong> for cluster cards. Use{" "}
                    <code>--emit=md</code> in Extra argv only for Hermes-style markdown export.
                  </p>
                </div>
                <div className="chips">
                  <button
                    type="button"
                    className={`chip ${mock ? "on" : ""}`}
                    onClick={() => setMock((v) => !v)}
                  >
                    mock
                  </button>
                  <button
                    type="button"
                    className={`chip ${hiringSignals ? "on" : ""}`}
                    onClick={() => setHiringSignals((v) => !v)}
                  >
                    hiring signals
                  </button>
                  <button
                    type="button"
                    className={`chip ${competitors ? "on" : ""}`}
                    onClick={() => setCompetitors((v) => !v)}
                  >
                    competitors
                  </button>
                  <button
                    type="button"
                    className={`chip ${deepResearch ? "on" : ""}`}
                    onClick={() => setDeepResearch((v) => !v)}
                  >
                    deep research
                  </button>
                </div>
                <details className="advanced">
                  <summary>Advanced</summary>
                  <div className="advanced-body">
                    <label>
                      --search override
                      <input
                        value={searchOverride}
                        onChange={(e) => setSearchOverride(e.target.value)}
                        placeholder="reddit,youtube,hn,web"
                      />
                    </label>
                    <label>
                      Extra argv
                      <input
                        value={advanced}
                        onChange={(e) => setAdvanced(e.target.value)}
                        placeholder="--github-user=steipete --subreddits=…"
                      />
                    </label>
                  </div>
                </details>
                <div className="actions-row">
                  <p className="hint">Enter to run · Cancel stops the live job</p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      disabled={!busy}
                      onClick={() => void cancelActive()}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void startResearch()}
                    >
                      {busy ? "Running…" : "Run research"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="panel log-panel">
                <div className="panel-head">
                  <p className="eyebrow">Live log</p>
                  {busy ? <span className="run-status running">streaming</span> : null}
                </div>
                <div className={`log-box ${logLines.length ? "" : "is-empty"}`}>
                  {logLines.join("\n") || "Waiting for a run…"}
                </div>
              </div>
            </div>

            <div className="results-layout">
              <div className="panel form-grid results-main">
                <div className="panel-head">
                  <p className="eyebrow">Results</p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn compact"
                      disabled={busy}
                      onClick={() => void runDrill()}
                    >
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
                      Verify freshness
                    </button>
                  </div>
                </div>
                <label>
                  Drill target (cluster index or title)
                  <input value={drillTarget} onChange={(e) => setDrillTarget(e.target.value)} />
                </label>
                <ResearchReportView text={resultText} />
              </div>

              <div className="panel form-grid runs-rail">
                <div className="panel-head">
                  <p className="eyebrow">Recent runs</p>
                </div>
                {runs.length === 0 ? (
                  <p className="runs-empty">No runs yet.</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 10).map((r) => (
                        <tr key={r.id}>
                          <td>
                            {new Date(r.createdAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </td>
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

        {nav === "watchlist" && (
          <section className="panel form-grid companion-stack">
            <div className="panel-head">
              <p className="eyebrow">Watchlist</p>
            </div>
            <p className="hint">
              Recurring topics to re-research on a schedule. Try{" "}
              <code>list</code>, <code>add My Topic</code>, or <code>run-all</code>.
            </p>
            <label>
              Args
              <input value={watchArgs} onChange={(e) => setWatchArgs(e.target.value)} />
            </label>
            <div className="row end">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void fetchJson<{ stdout: string; stderr: string }>(`${API}/watchlist`, {
                    method: "POST",
                    body: JSON.stringify({ args: watchArgs.trim().split(/\s+/).filter(Boolean) }),
                  }).then((d) => setCompanionOut(`${d.stdout}\n${d.stderr}`));
                }}
              >
                Run watchlist
              </button>
            </div>
            <div className={`result-box ${companionOut ? "" : "is-empty"}`}>
              {companionOut || "Output appears here."}
            </div>
          </section>
        )}

        {nav === "store" && (
          <section className="panel form-grid companion-stack">
            <div className="panel-head">
              <p className="eyebrow">Store</p>
            </div>
            <p className="hint">
              SQLite findings store. Typical args: <code>stats</code>, <code>search …</code>,{" "}
              <code>trending</code>.
            </p>
            <label>
              Args
              <input value={storeArgs} onChange={(e) => setStoreArgs(e.target.value)} />
            </label>
            <div className="row end">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void fetchJson<{ stdout: string; stderr: string }>(`${API}/store`, {
                    method: "POST",
                    body: JSON.stringify({ args: storeArgs.trim().split(/\s+/).filter(Boolean) }),
                  }).then((d) => setCompanionOut(`${d.stdout}\n${d.stderr}`));
                }}
              >
                Run store
              </button>
            </div>
            <div className={`result-box ${companionOut ? "" : "is-empty"}`}>
              {companionOut || "Output appears here."}
            </div>
          </section>
        )}

        {nav === "briefings" && (
          <section className="panel form-grid companion-stack">
            <div className="panel-head">
              <p className="eyebrow">Briefings</p>
            </div>
            <p className="hint">
              Digests from the store. Try <code>show</code> or <code>generate --weekly</code>.
            </p>
            <label>
              Args
              <input value={briefArgs} onChange={(e) => setBriefArgs(e.target.value)} />
            </label>
            <div className="row end">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void fetchJson<{ stdout: string; stderr: string }>(`${API}/briefings`, {
                    method: "POST",
                    body: JSON.stringify({ args: briefArgs.trim().split(/\s+/).filter(Boolean) }),
                  }).then((d) => setCompanionOut(`${d.stdout}\n${d.stderr}`));
                }}
              >
                Run briefing
              </button>
            </div>
            <div className={`result-box ${companionOut ? "" : "is-empty"}`}>
              {companionOut || "Output appears here."}
            </div>
          </section>
        )}

        {nav === "doctor" && (
          <section className="panel form-grid companion-stack">
            <div className="panel-head">
              <p className="eyebrow">Doctor</p>
            </div>
            <p className="hint">Health checks when a source looks thin or setup seems off.</p>
            <div className="row">
              {["json", "cached", "probe", "postmortem", "plain"].map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="btn compact"
                  disabled={busy}
                  onClick={() => void loadDoctor(mode)}
                >
                  {mode}
                </button>
              ))}
              <button
                type="button"
                className="btn compact"
                onClick={() => {
                  void fetchJson<{ stdout: string }>(`${API}/preflight`).then((d) =>
                    setDoctorOut(d.stdout),
                  );
                }}
              >
                preflight
              </button>
              <button
                type="button"
                className="btn compact"
                onClick={() => {
                  void fetchJson<{ stdout: string }>(`${API}/diagnose`).then((d) =>
                    setDoctorOut(d.stdout),
                  );
                }}
              >
                diagnose
              </button>
            </div>
            <div className={`result-box ${doctorOut ? "" : "is-empty"}`}>
              {doctorOut || "Run a check to inspect source health."}
            </div>
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
                    ? "Social sources use the fleet ScrapeCreators relay (no API key on this box). Pick a source tier below."
                    : "Paste your ScrapeCreators API key and pick a source tier. You can change this later from the gear (Settings)."}
                </p>
                {scRelay ? (
                  <p className="policy-note">ScrapeCreators: fleet relay active (CP proxy)</p>
                ) : (
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
                  Custom INCLUDE_SOURCES
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
                    Save everything tier
                  </button>
                  <button type="button" className="btn" onClick={() => void saveSetup("custom")}>
                    Save custom includes
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
                <div className="policy-note">
                  Forbidden in this app: FROM_BROWSER, AUTH_TOKEN/CT0, XAI_API_KEY, XQUIK_API_KEY,
                  yt-dlp, Brave/Serper/Parallel. X/Twitter stays off without those backends.
                </div>
                {scRelay ? (
                  <p className="policy-note">ScrapeCreators: fleet relay active (no key stored on box)</p>
                ) : (
                <label>
                  ScrapeCreators API key (leave blank to keep saved)
                  <input type="password" value={scKey} onChange={(e) => setScKey(e.target.value)} />
                </label>
                )}
                <label>
                  INCLUDE_SOURCES
                  <input value={includeSources} onChange={(e) => setIncludeSources(e.target.value)} />
                </label>
                <label>
                  LAST30DAYS_MEMORY_DIR
                  <input value={memoryDir} onChange={(e) => setMemoryDir(e.target.value)} />
                </label>
                <label>
                  Register default
                  <select value={register} onChange={(e) => setRegister(e.target.value)}>
                    <option value="default">default</option>
                    <option value="exec">exec</option>
                    <option value="dev">dev</option>
                    <option value="creator">creator</option>
                    <option value="eli5">eli5</option>
                  </select>
                </label>
                <label style={{ flexDirection: "row", alignItems: "center", gap: "0.6rem" }}>
                  <input
                    type="checkbox"
                    checked={storeEnabled}
                    onChange={(e) => setStoreEnabled(e.target.checked)}
                  />
                  Persist findings to SQLite (--store / LAST30DAYS_STORE)
                </label>
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
                <pre className="result-box">{JSON.stringify(status?.config || {}, null, 2)}</pre>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
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
