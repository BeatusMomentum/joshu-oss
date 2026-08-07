/**
 * Subprocess runner for the vendored last30days engine (SC-only hardened).
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DIRECT_LLM_ENV_KEYS,
  FORBIDDEN_ENV_KEYS,
  pickInheritedProcessEnv,
  readConfigFile,
  resolveConfigDir,
  resolveEngineScript,
  resolveExaApiKey,
  resolvePythonBin,
  resolveReasoningEnv,
  resolveScrapeCreatorsRelayEnv,
  scrapeCreatorsRelayConfigured,
  resolveWebBackendChoice,
  sanitizePathNoYtdlp,
} from "./config.js";
import { exportLast30DaysRunReport, notifyLast30DaysRunSession } from "./runDelivery.js";

export type Last30DaysRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type Last30DaysRunEvent =
  | { type: "stderr"; line: string; ts: number }
  | { type: "stdout"; chunk: string; ts: number }
  | { type: "status"; status: Last30DaysRunStatus; ts: number }
  | { type: "done"; exitCode: number | null; ts: number; error?: string };

export type Last30DaysRunRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: Last30DaysRunStatus;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  error?: string;
  stdout: string;
  stderrLines: string[];
  events: Last30DaysRunEvent[];
  /** Research topic (denormalized for delivery + export). */
  topic?: string;
  /** Hermes session to reply in when run completes out-of-app. */
  hermesSessionKey?: string;
  hermesSessionId?: string;
  /** Path under JOSHU_FILES_ROOT after markdown export. */
  outputRelativePath?: string;
};

export type SpawnEngineOpts = {
  projectRoot: string;
  args: string[];
  /** Extra env (already scrubbed). */
  env?: Record<string, string>;
  configDir?: string;
  meta?: {
    topic?: string;
    hermesSessionKey?: string;
    hermesSessionId?: string;
  };
};

const runs = new Map<string, Last30DaysRunRecord>();
const children = new Map<string, ChildProcess>();
const MAX_RUNS = 40;
const MAX_STDOUT = 8_000_000;
const MAX_EVENTS = 5_000;

/** Set by initRunStore so list/get can hydrate after Joshu restarts. */
let runsRootDir: string | null = null;
let hydratedFromDisk = false;

function runsDir(projectRoot: string): string {
  return path.join(projectRoot, ".joshu", "last30days", "runs");
}

function isRunStatus(value: unknown): value is Last30DaysRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function coercePersistedRun(raw: unknown): Last30DaysRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.createdAt !== "number") return null;
  if (!isRunStatus(o.status)) return null;
  return {
    id: o.id,
    createdAt: o.createdAt,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : o.createdAt,
    status: o.status,
    argv: Array.isArray(o.argv) ? o.argv.map(String) : [],
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    exitCode: typeof o.exitCode === "number" ? o.exitCode : o.exitCode === null ? null : null,
    error: typeof o.error === "string" ? o.error : undefined,
    stdout: typeof o.stdout === "string" ? o.stdout : "",
    stderrLines: Array.isArray(o.stderrLines) ? o.stderrLines.map(String) : [],
    events: Array.isArray(o.events) ? (o.events as Last30DaysRunEvent[]) : [],
    topic: typeof o.topic === "string" ? o.topic : undefined,
    hermesSessionKey: typeof o.hermesSessionKey === "string" ? o.hermesSessionKey : undefined,
    hermesSessionId: typeof o.hermesSessionId === "string" ? o.hermesSessionId : undefined,
    outputRelativePath: typeof o.outputRelativePath === "string" ? o.outputRelativePath : undefined,
  };
}

function readRunFile(filePath: string): Last30DaysRunRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return coercePersistedRun(raw);
  } catch {
    return null;
  }
}

function hydrateRunsFromDisk(): void {
  if (hydratedFromDisk || !runsRootDir) return;
  hydratedFromDisk = true;
  try {
    if (!fs.existsSync(runsRootDir)) return;
    for (const name of fs.readdirSync(runsRootDir)) {
      if (!name.endsWith(".json")) continue;
      const loaded = readRunFile(path.join(runsRootDir, name));
      if (!loaded) continue;
      // Live in-memory runs win over stale disk snapshots.
      if (runs.has(loaded.id)) continue;
      // Never resurrect a "running" child that isn't actually ours.
      if (loaded.status === "running" || loaded.status === "queued") {
        loaded.status = "failed";
        loaded.error = loaded.error || "Interrupted (server restarted)";
      }
      runs.set(loaded.id, loaded);
    }
  } catch {
    /* best-effort */
  }
}

/** Call once at route registration so Recent runs survive Joshu restarts. */
export function initRunStore(projectRoot: string): void {
  runsRootDir = runsDir(projectRoot);
  hydratedFromDisk = false;
  hydrateRunsFromDisk();
}

/** Persist run snapshot (exported for delivery layer re-write after export). */
export function persistRunRecord(projectRoot: string, run: Last30DaysRunRecord): void {
  persistRun(projectRoot, run);
}

function persistRun(projectRoot: string, run: Last30DaysRunRecord): void {
  try {
    const dir = runsDir(projectRoot);
    runsRootDir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slim = {
      ...run,
      // Cap persisted stdout
      stdout: run.stdout.length > 500_000 ? `${run.stdout.slice(0, 500_000)}\n…truncated` : run.stdout,
      events: run.events.slice(-500),
    };
    fs.writeFileSync(path.join(dir, `${run.id}.json`), `${JSON.stringify(slim, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
}

function pushEvent(run: Last30DaysRunRecord, event: Last30DaysRunEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) {
    run.events.splice(0, run.events.length - MAX_EVENTS);
  }
  run.updatedAt = Date.now();
}

function pruneRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  const ordered = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
  while (ordered.length > MAX_RUNS) {
    const old = ordered.shift();
    if (!old) break;
    if (old.status === "running" || old.status === "queued") continue;
    runs.delete(old.id);
  }
}

/** Build child env: per-box keys + app config + scrub forbidden keys + no yt-dlp PATH. */
export function buildHardenedEnv(
  projectRoot: string,
  configDir = resolveConfigDir(),
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const fileEnv = readConfigFile(configDir);
  const reasoningEnv = resolveReasoningEnv(projectRoot, fileEnv);
  const scRelayEnv = resolveScrapeCreatorsRelayEnv();
  const { key: exaKey } = resolveExaApiKey(projectRoot, fileEnv);
  const mergedFileEnv = { ...fileEnv };
  if (scRelayEnv.SCRAPECREATORS_API_KEY) {
    delete mergedFileEnv.SCRAPECREATORS_API_KEY;
    delete mergedFileEnv.SCRAPE_CREATORS_API_KEY;
  }
  const env: NodeJS.ProcessEnv = {
    ...pickInheritedProcessEnv(),
    ...mergedFileEnv,
    ...reasoningEnv,
    ...scRelayEnv,
    ...extra,
    LAST30DAYS_CONFIG_DIR: configDir,
    PATH: sanitizePathNoYtdlp(process.env.PATH || ""),
    // Never signal host native search — Exa (or keyless) grounding stays in-engine.
    LAST30DAYS_NATIVE_SEARCH: "",
  };
  if (exaKey) {
    env.EXA_API_KEY = exaKey;
  }

  for (const key of FORBIDDEN_ENV_KEYS) {
    delete env[key];
  }
  // Never let a dev laptop shell's Gemini/OpenAI keys override fleet OpenRouter policy.
  for (const key of DIRECT_LLM_ENV_KEYS) {
    delete env[key];
  }
  // Empty string delete for native search
  delete env.LAST30DAYS_NATIVE_SEARCH;

  // Belt-and-suspenders: never inherit cookies from host Hermes even if set.
  delete env.FROM_BROWSER;
  delete env.AUTH_TOKEN;
  delete env.CT0;
  delete env.XAI_API_KEY;
  delete env.XQUIK_API_KEY;

  // OPENROUTER must come from resolveReasoningEnv (box secrets / app file), not host spread.
  if (!reasoningEnv.OPENROUTER_API_KEY) {
    delete env.OPENROUTER_API_KEY;
  }

  return env;
}

export function listRuns(): Last30DaysRunRecord[] {
  hydrateRunsFromDisk();
  return [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** First positional topic in engine argv (after python + script). */
export function topicFromRunArgv(argv?: string[]): string | undefined {
  if (!argv || argv.length < 3) return undefined;
  const candidate = argv[2];
  if (!candidate || candidate.startsWith("-")) return undefined;
  return candidate;
}

/** Skip duplicate concurrent spawns for the same topic (agent double-fire, etc.). */
export function findActiveRunForTopic(topic: string): Last30DaysRunRecord | undefined {
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const run of listRuns()) {
    if (run.status !== "running" && run.status !== "queued") continue;
    const runTopic = topicFromRunArgv(run.argv);
    if (runTopic?.trim().toLowerCase() === normalized) return run;
  }
  return undefined;
}

export function getRun(id: string): Last30DaysRunRecord | undefined {
  hydrateRunsFromDisk();
  const mem = runs.get(id);
  if (mem) return mem;
  if (!runsRootDir) return undefined;
  const loaded = readRunFile(path.join(runsRootDir, `${id}.json`));
  if (loaded) {
    if (loaded.status === "running" || loaded.status === "queued") {
      loaded.status = "failed";
      loaded.error = loaded.error || "Interrupted (server restarted)";
    }
    runs.set(loaded.id, loaded);
  }
  return loaded ?? undefined;
}

export function attachHermesSessionToRun(
  runId: string,
  projectRoot: string,
  meta: { hermesSessionKey?: string; hermesSessionId?: string },
): Last30DaysRunRecord | undefined {
  const run = getRun(runId);
  if (!run) return undefined;
  const key = meta.hermesSessionKey?.trim();
  const id = meta.hermesSessionId?.trim();
  if (key) run.hermesSessionKey = key;
  if (id) run.hermesSessionId = id;
  if (!key && !id) return run;
  persistRun(projectRoot, run);
  return run;
}

export function cancelRun(id: string): boolean {
  const child = children.get(id);
  const run = runs.get(id);
  if (!child || !run) return false;
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3_000);
  } catch {
    return false;
  }
  run.status = "cancelled";
  pushEvent(run, { type: "status", status: "cancelled", ts: Date.now() });
  return true;
}

/**
 * Always injects --no-browser-cookies unless already present.
 * Prefers --web-backend=exa when EXA_API_KEY is available, else keyless.
 */
export function hardenArgv(
  args: string[],
  opts: { projectRoot?: string; configDir?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const out = [...args];
  if (!out.includes("--no-browser-cookies")) {
    out.push("--no-browser-cookies");
  }
  const hasWebBackend = out.some((a) => a === "--web-backend" || a.startsWith("--web-backend="));
  if (!hasWebBackend) {
    const projectRoot = opts.projectRoot || process.cwd();
    const configDir = opts.configDir || resolveConfigDir();
    const fileEnv = readConfigFile(configDir);
    // Prefer already-resolved child env when caller built it first.
    const fromEnv = opts.env?.EXA_API_KEY?.trim() ? "exa" : null;
    const backend = fromEnv || resolveWebBackendChoice(projectRoot, fileEnv);
    out.push(`--web-backend=${backend}`);
  }
  return out;
}

export function spawnEngine(opts: SpawnEngineOpts): Last30DaysRunRecord {
  const script = resolveEngineScript(opts.projectRoot);
  if (!fs.existsSync(script)) {
    throw new Error(
      `last30days engine missing at ${script}. Run: bash scripts/sync-last30days-skill.sh`,
    );
  }

  const configDir = opts.configDir || resolveConfigDir();
  const env = buildHardenedEnv(opts.projectRoot, configDir, opts.env);
  const argv = hardenArgv(opts.args, {
    projectRoot: opts.projectRoot,
    configDir,
    env,
  });
  const id = randomUUID();
  const cwd = path.dirname(script);
  const python = resolvePythonBin();

  const run: Last30DaysRunRecord = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    argv: [python, script, ...argv],
    cwd,
    exitCode: null,
    stdout: "",
    stderrLines: [],
    events: [],
    topic: opts.meta?.topic?.trim() || topicFromRunArgv([python, script, ...argv]),
    hermesSessionKey: opts.meta?.hermesSessionKey?.trim() || undefined,
    hermesSessionId: opts.meta?.hermesSessionId?.trim() || undefined,
  };
  runs.set(id, run);
  pruneRuns();
  pushEvent(run, { type: "status", status: "queued", ts: Date.now() });

  const child = spawn(python, [script, ...argv], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(id, child);
  run.status = "running";
  pushEvent(run, { type: "status", status: "running", ts: Date.now() });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    if (run.stdout.length < MAX_STDOUT) {
      const room = MAX_STDOUT - run.stdout.length;
      run.stdout += chunk.length > room ? chunk.slice(0, room) : chunk;
    }
    pushEvent(run, { type: "stdout", chunk, ts: Date.now() });
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    const parts = stderrBuf.split(/\r?\n/);
    stderrBuf = parts.pop() ?? "";
    for (const line of parts) {
      run.stderrLines.push(line);
      if (run.stderrLines.length > 2_000) run.stderrLines.shift();
      pushEvent(run, { type: "stderr", line, ts: Date.now() });
    }
  });

  child.on("error", (err) => {
    run.status = "failed";
    run.error = err.message;
    pushEvent(run, { type: "status", status: "failed", ts: Date.now() });
    pushEvent(run, { type: "done", exitCode: null, ts: Date.now(), error: err.message });
    children.delete(id);
    const exportResult = exportLast30DaysRunReport(opts.projectRoot, run);
    void notifyLast30DaysRunSession(opts.projectRoot, run, exportResult).catch(() => undefined);
  });

  child.on("close", (code) => {
    if (stderrBuf) {
      run.stderrLines.push(stderrBuf);
      pushEvent(run, { type: "stderr", line: stderrBuf, ts: Date.now() });
      stderrBuf = "";
    }
    run.exitCode = code;
    if (run.status !== "cancelled") {
      run.status = code === 0 ? "completed" : "failed";
      if (code !== 0 && !run.error) {
        run.error = `Engine exited with code ${code}`;
      }
    }
    pushEvent(run, { type: "status", status: run.status, ts: Date.now() });
    if (run.status === "completed" || run.status === "failed") {
      const exportResult = exportLast30DaysRunReport(opts.projectRoot, run);
      void notifyLast30DaysRunSession(opts.projectRoot, run, exportResult).catch((err: Error) => {
        console.warn(`[last30days] session delivery failed: ${err.message}`);
      });
    }
    pushEvent(run, {
      type: "done",
      exitCode: code,
      ts: Date.now(),
      error: run.error,
    });
    children.delete(id);
    persistRun(opts.projectRoot, run);
  });

  return run;
}

/** Synchronous-style helper: wait for run completion. */
export function waitForRun(
  id: string,
  timeoutMs = 600_000,
): Promise<Last30DaysRunRecord> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const run = runs.get(id);
      if (!run) {
        reject(new Error(`Unknown run ${id}`));
        return;
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        resolve(run);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        cancelRun(id);
        reject(new Error(`Run ${id} timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

export type ResearchRequest = {
  topic?: string;
  mode?: "research" | "discover" | "drill" | "doctor" | "preflight" | "diagnose" | "welcome" | "verify-freshness";
  emit?: "compact" | "json" | "context" | "md" | "html" | "brief";
  jsonProfile?: "agent" | "raw";
  quick?: boolean;
  deep?: boolean;
  days?: number;
  asOf?: string;
  register?: string;
  search?: string;
  saveDir?: string;
  saveSuffix?: string;
  store?: boolean;
  discover?: string | boolean;
  discoverShallow?: boolean;
  nominateOnly?: boolean;
  judgments?: string;
  finalize?: boolean;
  angles?: string;
  drill?: string;
  doctorMode?: "plain" | "json" | "cached" | "postmortem" | "probe";
  competitors?: number | boolean;
  competitorsList?: string;
  hiringSignals?: boolean;
  deepResearch?: boolean;
  githubUser?: string;
  githubRepo?: string;
  xHandle?: string;
  subreddits?: string;
  tiktokHashtags?: string;
  tiktokCreators?: string;
  igCreators?: string;
  trustpilotDomain?: string;
  polymarketKeywords?: string;
  corpus?: string[];
  corpusAllTime?: boolean;
  debug?: boolean;
  mock?: boolean;
  maxResults?: number;
  autoResolve?: boolean;
  library?: { action: "feed" | "search"; query?: string; publish?: boolean };
  queue?: { action: "list" | "cover"; topic?: string };
  /** Raw extra argv after hardened defaults (advanced). */
  extraArgs?: string[];
};

export function researchRequestToArgs(req: ResearchRequest): string[] {
  if (req.library) {
    const args = ["library", req.library.action];
    if (req.library.action === "search" && req.library.query) args.push(req.library.query);
    if (req.library.publish) args.push("--publish");
    return args;
  }
  if (req.queue) {
    if (req.queue.action === "list") return ["queue", "list"];
    if (req.queue.action === "cover" && req.queue.topic) return ["queue", "cover", req.queue.topic];
    throw new Error("queue.cover requires topic");
  }

  const args: string[] = [];
  const mode = req.mode || "research";

  if (mode === "doctor") {
    args.push("doctor");
    if (req.doctorMode === "json") args.push("--json");
    if (req.doctorMode === "cached") args.push("--cached");
    if (req.doctorMode === "postmortem") args.push("--postmortem");
    if (req.doctorMode === "probe") args.push("--probe");
    return args;
  }
  if (mode === "preflight") {
    args.push("--preflight");
    if (req.emit === "json") args.push("--emit=json");
    return args;
  }
  if (mode === "diagnose") {
    args.push("--diagnose");
    return args;
  }
  if (mode === "welcome") {
    args.push("--welcome");
    return args;
  }
  if (mode === "verify-freshness") {
    args.push("--verify-freshness");
    if (req.topic) args.push(req.topic);
    return args;
  }
  if (mode === "drill") {
    if (!req.drill) throw new Error("drill target required");
    args.push(`--drill=${req.drill}`);
  }
  if (mode === "discover" || req.discover !== undefined) {
    if (req.discover === true || req.discover === "") {
      args.push("--discover");
    } else if (typeof req.discover === "string") {
      args.push("--discover", req.discover);
    } else {
      args.push("--discover");
    }
    if (req.discoverShallow) args.push("--discover-shallow");
    if (req.nominateOnly) args.push("--nominate-only");
    if (req.judgments) args.push("--judgments", req.judgments);
    if (req.finalize) args.push("--finalize");
    if (req.angles) args.push("--angles", req.angles);
  }

  if (req.topic && mode === "research") {
    args.push(req.topic);
  }

  const emit = req.emit || "json";
  args.push(`--emit=${emit}`);
  if (emit === "json") {
    args.push(`--json-profile=${req.jsonProfile || "agent"}`);
  }
  if (req.quick) args.push("--quick");
  if (req.deep) args.push("--deep");
  if (req.days != null) args.push(`--days=${req.days}`);
  if (req.asOf) args.push(`--as-of=${req.asOf}`);
  if (req.register) args.push(`--register=${req.register}`);
  if (req.search) args.push(`--search=${req.search}`);
  if (req.saveDir) args.push(`--save-dir=${req.saveDir}`);
  if (req.saveSuffix) args.push(`--save-suffix=${req.saveSuffix}`);
  if (req.store) args.push("--store");
  if (req.competitors === true) args.push("--competitors");
  else if (typeof req.competitors === "number") args.push(`--competitors=${req.competitors}`);
  if (req.competitorsList) args.push(`--competitors-list=${req.competitorsList}`);
  if (req.hiringSignals) args.push("--hiring-signals");
  if (req.deepResearch) args.push("--deep-research");
  if (req.githubUser) args.push(`--github-user=${req.githubUser}`);
  if (req.githubRepo) args.push(`--github-repo=${req.githubRepo}`);
  if (req.xHandle) args.push(`--x-handle=${req.xHandle}`);
  if (req.subreddits) args.push(`--subreddits=${req.subreddits}`);
  if (req.tiktokHashtags) args.push(`--tiktok-hashtags=${req.tiktokHashtags}`);
  if (req.tiktokCreators) args.push(`--tiktok-creators=${req.tiktokCreators}`);
  if (req.igCreators) args.push(`--ig-creators=${req.igCreators}`);
  if (req.trustpilotDomain) args.push(`--trustpilot-domain=${req.trustpilotDomain}`);
  if (req.polymarketKeywords) args.push(`--polymarket-keywords=${req.polymarketKeywords}`);
  if (req.corpus) {
    for (const dir of req.corpus) args.push("--corpus", dir);
  }
  if (req.corpusAllTime) args.push("--corpus-all-time");
  if (req.debug) args.push("--debug");
  if (req.mock) args.push("--mock");
  if (req.maxResults != null) args.push(`--max-results=${req.maxResults}`);
  if (req.autoResolve) args.push("--auto-resolve");
  if (req.extraArgs?.length) args.push(...req.extraArgs);

  return args;
}
