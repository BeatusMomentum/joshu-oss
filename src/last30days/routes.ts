/**
 * Joshu REST API for the last30days desktop app.
 */

import type { Request, Response, Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  EVERYTHING_INCLUDE_SOURCES,
  RECOMMENDED_INCLUDE_SOURCES,
  defaultMemoryDir,
  publicConfigView,
  readConfigFile,
  resolveConfigDir,
  resolveLast30DaysEngine,
  resolvePythonBin,
  resolveWebBackendChoice,
  scrapeCreatorsRelayConfigured,
  xquikRelayConfigured,
  writeConfigFile,
} from "./config.js";
import {
  attachHermesSessionToRun,
  cancelRun,
  findActiveRunForTopic,
  getRun,
  initRunStore,
  listRuns,
  researchRequestToArgs,
  spawnEngine,
  topicFromRunArgv,
  waitForRun,
  type ResearchRequest,
} from "./runner.js";
import {
  deletePersistedQueryPlan,
  enrichResearchRequest,
  ensureQueryPlanForWatch,
} from "./queryPlan.js";
import { runCompanion } from "./companions.js";
import {
  addWatch,
  buildWatchReport,
  filterWatchingForCadence,
  listWatching,
  removeWatch,
  type WatchCadence,
} from "./watching.js";
import {
  appendWatchSnapshot,
  snapshotFromStdout,
  WATCH_WINDOW_DAYS,
} from "./watchSnapshots.js";

function readHermesSession(
  req: Request,
  body: Record<string, unknown>,
): { hermesSessionKey?: string; hermesSessionId?: string } {
  const key =
    readString(req.headers["x-hermes-session-key"]) ||
    readString(body.hermesSessionKey) ||
    readString((body.args as Record<string, unknown> | undefined)?.hermesSessionKey);
  const id =
    readString(req.headers["x-hermes-session-id"]) ||
    readString(body.hermesSessionId) ||
    readString((body.args as Record<string, unknown> | undefined)?.hermesSessionId);
  return {
    ...(key ? { hermesSessionKey: key } : {}),
    ...(id ? { hermesSessionId: id } : {}),
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readWatchCadence(body: Record<string, unknown>): WatchCadence | undefined {
  const nested = body.args && typeof body.args === "object" && !Array.isArray(body.args)
    ? (body.args as Record<string, unknown>)
    : undefined;
  const raw = readString(body.cadence) || readString(nested?.cadence);
  if (raw === "weekly" || raw === "daily") return raw;
  return undefined;
}

function projectRootFrom(req: Request, fallback: string): string {
  const fromApp = typeof (req as { joshuProjectRoot?: string }).joshuProjectRoot === "string"
    ? (req as { joshuProjectRoot?: string }).joshuProjectRoot
    : undefined;
  return fromApp || fallback;
}

export function registerLast30DaysRoutes(router: Router, opts: { projectRoot: string }): void {
  const { projectRoot } = opts;
  initRunStore(projectRoot);

  router.get("/api/last30days/status", (_req: Request, res: Response) => {
    const engine = resolveLast30DaysEngine(projectRoot);
    const configDir = resolveConfigDir(undefined, projectRoot);
    const entries = readConfigFile(configDir);
    const webBackend = resolveWebBackendChoice(projectRoot, entries);
    res.json({
      ok: true,
      enginePresent: engine.present,
      engineScript: engine.script,
      engineSource: engine.source,
      python: resolvePythonBin(),
      configDir,
      config: publicConfigView(entries, projectRoot),
      policy: {
        scrapecreatorsOnly: true,
        cookies: false,
        ytdlp: false,
        web: webBackend,
        x: xquikRelayConfigured()
          ? "xquik (fleet relay)"
          : "xquik when XQUIK_API_KEY is set (self-host)",
      },
    });
  });

  router.get("/api/last30days/config", (_req: Request, res: Response) => {
    const entries = readConfigFile(resolveConfigDir(undefined, projectRoot));
    res.json({ ok: true, config: publicConfigView(entries, projectRoot) });
  });

  router.put("/api/last30days/config", (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      if (scrapeCreatorsRelayConfigured() && readString(body.scrapecreatorsApiKey)) {
        res.status(400).json({
          ok: false,
          error: "ScrapeCreators API keys cannot be stored on fleet boxes (CP relay mode).",
        });
        return;
      }
      if (xquikRelayConfigured() && readString(body.xquikApiKey)) {
        res.status(400).json({
          ok: false,
          error: "Xquik API keys cannot be stored on fleet boxes (CP relay mode).",
        });
        return;
      }
      const updates: Record<string, string | null> = {};
      const map: Record<string, string> = {
        scrapecreatorsApiKey: "SCRAPECREATORS_API_KEY",
        xquikApiKey: "XQUIK_API_KEY",
        includeSources: "INCLUDE_SOURCES",
        excludeSources: "EXCLUDE_SOURCES",
        memoryDir: "LAST30DAYS_MEMORY_DIR",
        store: "LAST30DAYS_STORE",
        register: "LAST30DAYS_REGISTER",
        defaultSearch: "LAST30DAYS_DEFAULT_SEARCH",
        setupComplete: "SETUP_COMPLETE",
        openrouterApiKey: "OPENROUTER_API_KEY",
        perplexityApiKey: "PERPLEXITY_API_KEY",
        bskyHandle: "BSKY_HANDLE",
        bskyAppPassword: "BSKY_APP_PASSWORD",
        truthsocialToken: "TRUTHSOCIAL_TOKEN",
        corpusDirs: "LAST30DAYS_CORPUS_DIRS",
      };
      for (const [jsKey, envKey] of Object.entries(map)) {
        if (!(jsKey in body)) continue;
        const raw = body[jsKey];
        if (raw === null || raw === "") {
          updates[envKey] = null;
          continue;
        }
        if (jsKey === "store" || jsKey === "setupComplete") {
          updates[envKey] = raw === true || raw === "1" || raw === "true" ? "1" : null;
          continue;
        }
        updates[envKey] = String(raw);
      }
      const next = writeConfigFile(updates, resolveConfigDir(undefined, projectRoot));
      res.json({ ok: true, config: publicConfigView(next, projectRoot) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/last30days/setup", (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        scrapecreatorsApiKey?: string;
        tier?: "recommended" | "everything" | "custom";
        includeSources?: string;
        markComplete?: boolean;
      };
      // Reject cookie setup paths explicitly.
      if (
        (req.body as { allowBrowserCookies?: boolean })?.allowBrowserCookies ||
        (req.body as { fromBrowser?: string })?.fromBrowser
      ) {
        res.status(400).json({
          ok: false,
          error: "Browser cookies are disabled in the Joshu last30days app (SC-only policy).",
        });
        return;
      }

      if (scrapeCreatorsRelayConfigured() && body.scrapecreatorsApiKey?.trim()) {
        res.status(400).json({
          ok: false,
          error: "ScrapeCreators API keys cannot be stored on fleet boxes (CP relay mode).",
        });
        return;
      }

      const updates: Record<string, string | null> = {};
      if (body.scrapecreatorsApiKey?.trim()) {
        updates.SCRAPECREATORS_API_KEY = body.scrapecreatorsApiKey.trim();
      }
      if (body.tier === "recommended") {
        updates.INCLUDE_SOURCES = RECOMMENDED_INCLUDE_SOURCES;
      } else if (body.tier === "everything") {
        updates.INCLUDE_SOURCES = EVERYTHING_INCLUDE_SOURCES;
      } else if (body.includeSources?.trim()) {
        updates.INCLUDE_SOURCES = body.includeSources.trim();
      }
      if (body.markComplete !== false) {
        updates.SETUP_COMPLETE = "1";
      }
      const next = writeConfigFile(updates, resolveConfigDir(undefined, projectRoot));
      res.json({ ok: true, config: publicConfigView(next, projectRoot) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/last30days/sources", (_req: Request, res: Response) => {
    const webBackend = resolveWebBackendChoice(
      projectRoot,
      readConfigFile(resolveConfigDir(undefined, projectRoot)),
    );
    const scRelay = scrapeCreatorsRelayConfigured();
    const scNeeds = scRelay ? "JOSHU_SCRAPECREATORS_MODE=relay" : "SCRAPECREATORS_API_KEY";
    const scNote = scRelay ? "Fleet CP relay (no key on box)" : undefined;
    res.json({
      ok: true,
      sources: [
        { id: "reddit", label: "Reddit", via: "public", always: true },
        { id: "hackernews", label: "Hacker News", via: "public", always: true },
        { id: "polymarket", label: "Polymarket", via: "public", always: true },
        { id: "github", label: "GitHub", via: "gh", always: true },
        { id: "stocktwits", label: "StockTwits", via: "public", note: "ticker/crypto topics" },
        { id: "youtube", label: "YouTube", via: "scrapecreators", needs: scNeeds, note: scNote },
        { id: "tiktok", label: "TikTok", via: "scrapecreators", include: "tiktok", needs: scNeeds, note: scNote },
        { id: "instagram", label: "Instagram", via: "scrapecreators", include: "instagram", needs: scNeeds, note: scNote },
        { id: "threads", label: "Threads", via: "scrapecreators", include: "threads", needs: scNeeds, note: scNote },
        { id: "pinterest", label: "Pinterest", via: "scrapecreators", include: "pinterest", needs: scNeeds, note: scNote },
        { id: "linkedin", label: "LinkedIn", via: "scrapecreators", include: "linkedin", needs: scNeeds, note: scNote },
        {
          id: "web",
          label: "Web",
          via: webBackend,
          note: webBackend === "exa" ? "Exa (fleet EXA_API_KEY)" : "DuckDuckGo keyless",
        },
        {
          id: "x",
          label: "X / Twitter",
          via: xquikRelayConfigured() ? "xquik-relay" : "xquik",
          note: xquikRelayConfigured()
            ? "Fleet CP relay (no key on box)"
            : "Paste XQUIK_API_KEY in Settings (self-host)",
        },
        { id: "digg", label: "Digg", via: "cli", note: "digg-pp-cli on PATH" },
        { id: "arxiv", label: "arXiv", via: "cli", note: "arxiv-pp-cli on PATH" },
        { id: "techmeme", label: "Techmeme", via: "cli", note: "techmeme-pp-cli on PATH" },
        { id: "bluesky", label: "Bluesky", via: "app-password" },
        { id: "perplexity", label: "Perplexity", via: "key", include: "perplexity" },
      ],
      recommendedInclude: RECOMMENDED_INCLUDE_SOURCES,
      everythingInclude: EVERYTHING_INCLUDE_SOURCES,
    });
  });

  const startRun = async (req: Request, res: Response, research: ResearchRequest) => {
    try {
      const body = (req.body || {}) as ResearchRequest & Record<string, unknown>;
      const topic = readString(research.topic);
      if (topic) {
        const existing = findActiveRunForTopic(topic);
        if (existing) {
          res.status(202).json({
            ok: true,
            runId: existing.id,
            status: existing.status,
            argv: existing.argv,
            deduped: true,
          });
          return;
        }
      }
      const root = projectRootFrom(req, projectRoot);
      const enriched = await enrichResearchRequest(root, research);
      const args = researchRequestToArgs(enriched);
      const run = spawnEngine({
        projectRoot: root,
        args,
        meta: {
          topic: topic || undefined,
          ...readHermesSession(req, body),
        },
      });
      res.status(202).json({
        ok: true,
        runId: run.id,
        status: run.status,
        argv: run.argv,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

  router.post("/api/last30days/research", (req: Request, res: Response) => {
    const body = (req.body || {}) as ResearchRequest;
    startRun(req, res, { ...body, mode: body.mode || "research" });
  });

  router.post("/api/last30days/discover", (req: Request, res: Response) => {
    const body = (req.body || {}) as ResearchRequest;
    startRun(req, res, { ...body, mode: "discover", discover: body.discover ?? true });
  });

  router.post("/api/last30days/drill", (req: Request, res: Response) => {
    const body = (req.body || {}) as ResearchRequest;
    startRun(req, res, { ...body, mode: "drill", drill: body.drill || readString(body.topic) });
  });

  router.post("/api/last30days/verify-freshness", (req: Request, res: Response) => {
    const body = (req.body || {}) as ResearchRequest;
    startRun(req, res, { ...body, mode: "verify-freshness" });
  });

  router.get("/api/last30days/doctor", async (req: Request, res: Response) => {
    try {
      const mode = readString(req.query.mode) || "json";
      const args = researchRequestToArgs({
        mode: "doctor",
        doctorMode: mode as ResearchRequest["doctorMode"],
      });
      const run = spawnEngine({ projectRoot, args });
      const done = await waitForRun(run.id, 120_000);
      res.json({
        ok: done.status === "completed",
        runId: done.id,
        exitCode: done.exitCode,
        stdout: done.stdout,
        stderr: done.stderrLines.slice(-80),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/last30days/preflight", async (_req: Request, res: Response) => {
    try {
      const run = spawnEngine({
        projectRoot,
        args: researchRequestToArgs({ mode: "preflight", emit: "json" }),
      });
      const done = await waitForRun(run.id, 60_000);
      res.json({
        ok: done.status === "completed",
        runId: done.id,
        exitCode: done.exitCode,
        stdout: done.stdout,
        stderr: done.stderrLines.slice(-40),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/last30days/diagnose", async (_req: Request, res: Response) => {
    try {
      const run = spawnEngine({
        projectRoot,
        args: researchRequestToArgs({ mode: "diagnose" }),
      });
      const done = await waitForRun(run.id, 90_000);
      res.json({
        ok: done.status === "completed",
        runId: done.id,
        exitCode: done.exitCode,
        stdout: done.stdout,
        stderr: done.stderrLines.slice(-40),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/last30days/welcome", async (_req: Request, res: Response) => {
    try {
      const run = spawnEngine({
        projectRoot,
        args: researchRequestToArgs({ mode: "welcome" }),
      });
      const done = await waitForRun(run.id, 30_000);
      res.json({ ok: true, text: done.stdout || done.stderrLines.join("\n") });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/api/last30days/runs", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      runs: listRuns().map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        status: r.status,
        exitCode: r.exitCode,
        error: r.error,
        argv: r.argv,
        topic: topicFromRunArgv(r.argv),
        outputRelativePath: r.outputRelativePath,
        reportUri: r.outputRelativePath ? `joshu://${r.outputRelativePath.replace(/^\/+/, "")}` : undefined,
      })),
    });
  });

  router.patch("/api/last30days/runs/:id/session", (req: Request, res: Response) => {
    const runId = readString(req.params.id);
    const body = (req.body || {}) as Record<string, unknown>;
    if (!runId) {
      res.status(400).json({ ok: false, error: "run id required" });
      return;
    }
    const updated = attachHermesSessionToRun(runId, projectRootFrom(req, projectRoot), {
      hermesSessionKey: readString(body.hermesSessionKey),
      hermesSessionId: readString(body.hermesSessionId),
    });
    if (!updated) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({
      ok: true,
      runId: updated.id,
      hermesSessionKey: updated.hermesSessionKey,
      hermesSessionId: updated.hermesSessionId,
    });
  });

  router.get("/api/last30days/runs/:id", (req: Request, res: Response) => {
    const run = getRun(readString(req.params.id));
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({ ok: true, run });
  });

  router.get("/api/last30days/runs/:id/events", (req: Request, res: Response) => {
    const run = getRun(readString(req.params.id));
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let cursor = 0;
    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Replay existing events
    while (cursor < run.events.length) {
      send(run.events[cursor]);
      cursor += 1;
    }

    const timer = setInterval(() => {
      const current = getRun(run.id);
      if (!current) {
        clearInterval(timer);
        res.end();
        return;
      }
      while (cursor < current.events.length) {
        send(current.events[cursor]);
        cursor += 1;
      }
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        clearInterval(timer);
        res.end();
      }
    }, 250);

    req.on("close", () => {
      clearInterval(timer);
    });
  });

  router.post("/api/last30days/runs/:id/cancel", (req: Request, res: Response) => {
    const ok = cancelRun(readString(req.params.id));
    if (!ok) {
      res.status(404).json({ ok: false, error: "run not found or not running" });
      return;
    }
    res.json({ ok: true });
  });

  // Library listing (memory dir briefs)
  router.get("/api/last30days/library", (_req: Request, res: Response) => {
    const entries = readConfigFile(resolveConfigDir(undefined, projectRoot));
    const memoryDir = entries.LAST30DAYS_MEMORY_DIR || defaultMemoryDir(projectRoot);
    if (!fs.existsSync(memoryDir)) {
      res.json({ ok: true, memoryDir, files: [] });
      return;
    }
    const files = fs
      .readdirSync(memoryDir)
      .filter((name) => /\.(md|html|json)$/i.test(name))
      .map((name) => {
        const full = path.join(memoryDir, name);
        const st = fs.statSync(full);
        return { name, path: full, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, memoryDir, files });
  });

  router.get("/api/last30days/library/file", (req: Request, res: Response) => {
    const filePath = readString(req.query.path);
    const entries = readConfigFile(resolveConfigDir(undefined, projectRoot));
    const memoryDir = path.resolve(
      entries.LAST30DAYS_MEMORY_DIR || defaultMemoryDir(projectRoot),
    );
    if (!filePath) {
      res.status(400).json({ ok: false, error: "path required" });
      return;
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(memoryDir + path.sep) && resolved !== memoryDir) {
      res.status(403).json({ ok: false, error: "path outside memory dir" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.type("text/plain").send(fs.readFileSync(resolved, "utf8"));
  });

  router.post("/api/last30days/library/search", (req: Request, res: Response) => {
    const query = readString((req.body as { query?: string })?.query);
    if (!query) {
      res.status(400).json({ ok: false, error: "query required" });
      return;
    }
    startRun(req, res, { library: { action: "search", query } });
  });

  router.post("/api/last30days/library/feed", (req: Request, res: Response) => {
    const publish = Boolean((req.body as { publish?: boolean })?.publish);
    startRun(req, res, { library: { action: "feed", publish } });
  });

  router.get("/api/last30days/queue", (req: Request, res: Response) => {
    startRun(req, res, { queue: { action: "list" } });
  });

  router.post("/api/last30days/queue/cover", (req: Request, res: Response) => {
    const topic = readString((req.body as { topic?: string })?.topic);
    if (!topic) {
      res.status(400).json({ ok: false, error: "topic required" });
      return;
    }
    startRun(req, res, { queue: { action: "cover", topic } });
  });

  const spawnWatchRun = async (
    topic: string,
    hermes?: { hermesSessionKey?: string; hermesSessionId?: string },
  ) => {
    const enriched = await enrichResearchRequest(
      projectRoot,
      {
        topic,
        emit: "json",
        jsonProfile: "agent",
        days: WATCH_WINDOW_DAYS,
        store: true,
      },
      { preferPersisted: true },
    );
    return spawnEngine({
      projectRoot,
      args: researchRequestToArgs(enriched),
      meta: { topic, watchTopic: topic, ...hermes },
    });
  };

  // JSON Watching API used by the GUI. CamelCase aliases exist so
  // POST /joshu/api/apps/last30days/invoke can proxy agent.actions[] by name
  // (see appInvokeRegistry.ts). DELETE is GUI-only; Hermes invoke uses POST watchingRemove.
  const watchingList = async (_req: Request, res: Response) => {
    try {
      const topics = await listWatching(projectRoot);
      res.json({ ok: true, topics, windowDays: WATCH_WINDOW_DAYS });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  };
  router.get("/api/last30days/watching", watchingList);
  router.get("/api/last30days/watchingList", watchingList);

  const watchingAdd = async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { topic?: string; cadence?: string; stdout?: string; runId?: string };
      const topic = readString(body.topic);
      if (!topic) {
        res.status(400).json({ ok: false, error: "topic required" });
        return;
      }
      const cadence = body.cadence === "weekly" ? "weekly" : "daily";
      await ensureQueryPlanForWatch(projectRoot, topic);
      const added = await addWatch(projectRoot, topic, cadence);
      if (body.stdout && body.runId) {
        const snap = snapshotFromStdout(body.stdout, {
          topic,
          runId: readString(body.runId) || `adopt-${Date.now()}`,
          windowDays: WATCH_WINDOW_DAYS,
        });
        if (snap) appendWatchSnapshot(projectRoot, snap);
      }
      res.json({ ...added, topics: await listWatching(projectRoot) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };
  router.post("/api/last30days/watching", watchingAdd);
  router.post("/api/last30days/watchingAdd", watchingAdd);

  const watchingRemove = async (req: Request, res: Response) => {
    try {
      const topic = readString((req.body as { topic?: string })?.topic) || readString(req.query.topic);
      if (!topic) {
        res.status(400).json({ ok: false, error: "topic required" });
        return;
      }
      await removeWatch(projectRoot, topic);
      deletePersistedQueryPlan(projectRoot, topic);
      res.json({ ok: true, topics: await listWatching(projectRoot) });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };
  router.delete("/api/last30days/watching", watchingRemove);
  router.post("/api/last30days/watchingRemove", watchingRemove);

  const watchingReport = (req: Request, res: Response) => {
    const topic = readString(req.query.topic) || readString((req.body as { topic?: string } | undefined)?.topic);
    if (!topic) {
      res.status(400).json({ ok: false, error: "topic required" });
      return;
    }
    const report = buildWatchReport(projectRoot, topic);
    const lastRunId = report.snapshots[report.snapshots.length - 1]?.runId;
    const run = lastRunId ? getRun(lastRunId) : undefined;
    res.json({
      ok: true,
      ...report,
      stdout: run?.stdout || "",
    });
  };
  router.get("/api/last30days/watching/report", watchingReport);
  router.get("/api/last30days/watchingReport", watchingReport);

  const watchingRun = async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const topic = readString(body.topic);
      if (!topic) {
        res.status(400).json({ ok: false, error: "topic required" });
        return;
      }
      const run = await spawnWatchRun(topic, readHermesSession(req, body));
      res.status(202).json({ ok: true, runId: run.id, status: run.status, argv: run.argv });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };
  router.post("/api/last30days/watching/run", watchingRun);
  router.post("/api/last30days/watchingRun", watchingRun);

  /** Async (202) — jChat / plugin. Cron uses blocking watchlistRunAll instead. */
  const watchingRunAllAsync = async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const cadence = readWatchCadence(body);
      const topics = filterWatchingForCadence(await listWatching(projectRoot), cadence);
      const runIds: string[] = [];
      for (const row of topics) {
        const run = await spawnWatchRun(row.name, readHermesSession(req, body));
        runIds.push(run.id);
      }
      res.status(202).json({ ok: true, runIds, count: runIds.length, cadence: cadence || "all" });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  };
  router.post("/api/last30days/watching/run-all", watchingRunAllAsync);
  router.post("/api/last30days/watchingRunAll", watchingRunAllAsync);

  router.post("/api/last30days/watchlist", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { args?: string[] };
      const args = Array.isArray(body.args) ? body.args.map(String) : ["list"];
      const result = await runCompanion(projectRoot, "watchlist.py", args);
      res.json({ ok: result.exitCode === 0, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/last30days/store", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { args?: string[] };
      const args = Array.isArray(body.args) ? body.args.map(String) : ["stats"];
      const result = await runCompanion(projectRoot, "store.py", args);
      res.json({ ok: result.exitCode === 0, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/api/last30days/briefings", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { args?: string[] };
      const args = Array.isArray(body.args) ? body.args.map(String) : ["show"];
      const result = await runCompanion(projectRoot, "briefing.py", args);
      res.json({ ok: result.exitCode === 0, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  /** Invoke-friendly alias — re-research enabled watches (optional cadence) with a 7d window. */
  router.post("/api/last30days/watchlistRunAll", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const cadence = readWatchCadence(body);
      const topics = filterWatchingForCadence(await listWatching(projectRoot), cadence);
      const runIds: string[] = [];
      for (const row of topics) {
        const run = await spawnWatchRun(row.name, readHermesSession(req, body));
        runIds.push(run.id);
        await waitForRun(run.id, 600_000);
      }
      res.json({ ok: true, runIds, count: runIds.length, cadence: cadence || "all" });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  /** Invoke-friendly alias — generate briefing digest */
  router.post("/api/last30days/briefingGenerate", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { weekly?: boolean };
      const args = body.weekly ? ["generate", "--weekly"] : ["generate"];
      const result = await runCompanion(projectRoot, "briefing.py", args);
      res.json({ ok: result.exitCode === 0, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });
}
