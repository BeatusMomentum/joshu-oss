/**
 * last30days config + SC-only hardening for the Joshu desktop app.
 *
 * Policy (non-negotiable):
 * - No yt-dlp (PATH sanitized at spawn)
 * - No browser cookies / Bird / FROM_BROWSER
 * - No XAI / Xquik
 * - ScrapeCreators for YouTube + creator sources
 * - Web: Exa when EXA_API_KEY is on the box (fleet CP); else keyless DuckDuckGo
 * - Brave / Serper / Parallel stay scrubbed (not part of Joshu fleet web path)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBoxSecret } from "../boxSecrets/resolve.js";
import { JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL } from "../joshuOpenRouterDefaults.js";
import { joshuConfigDir } from "../nylas/paths.js";
import { provisionEnvTrim } from "../provisionInstanceEnv.js";

/** Sentinel value — engine sees SC as configured; http.py relay shim handles auth. */
export const SCRAPECREATORS_RELAY_SENTINEL = "relay";

export type ScrapeCreatorsMode = "relay" | "direct" | "off";

export const FORBIDDEN_ENV_KEYS = [
  "FROM_BROWSER",
  "AUTH_TOKEN",
  "CT0",
  "XAI_API_KEY",
  "XQUIK_API_KEY",
  "BRAVE_API_KEY",
  // EXA_API_KEY intentionally allowed — fleet web / grounding via CP DEFAULT_EXA_API_KEY
  "SERPER_API_KEY",
  "PARALLEL_API_KEY",
] as const;

/**
 * Direct vendor LLM keys must never reach the engine subprocess from the host
 * shell. Fleet boxes route planner/rerank through OpenRouter (per-box key);
 * without OpenRouter the engine falls back to deterministic/local scoring.
 */
export const DIRECT_LLM_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_AUTH_STATUS",
] as const;

/** Minimal process env forwarded to the Python engine (not full host inherit). */
export const SAFE_INHERITED_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "COMSPEC",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

/** Env keys the Joshu app may persist into ~/.config/last30days/.env */
export const ALLOWED_CONFIG_KEYS = [
  "SCRAPECREATORS_API_KEY",
  "INCLUDE_SOURCES",
  "EXCLUDE_SOURCES",
  "LAST30DAYS_MEMORY_DIR",
  "LAST30DAYS_STORE",
  "LAST30DAYS_REGISTER",
  "LAST30DAYS_DEFAULT_SEARCH",
  "SETUP_COMPLETE",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "BSKY_HANDLE",
  "BSKY_APP_PASSWORD",
  "TRUTHSOCIAL_TOKEN",
  "LAST30DAYS_CORPUS_DIRS",
] as const;

export type AllowedConfigKey = (typeof ALLOWED_CONFIG_KEYS)[number];

export const RECOMMENDED_INCLUDE_SOURCES =
  "tiktok,instagram,youtube_comments,tiktok_comments,instagram_comments";

export const EVERYTHING_INCLUDE_SOURCES =
  `${RECOMMENDED_INCLUDE_SOURCES},threads,pinterest,linkedin`;

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".config", "last30days");
}

export function resolveConfigDir(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.LAST30DAYS_CONFIG_DIR;
  if (fromEnv !== undefined) {
    // Empty string = no-config mode (engine convention); treat as default dir for our app.
    if (!fromEnv.trim()) return defaultConfigDir();
    return path.resolve(fromEnv.trim());
  }
  return defaultConfigDir();
}

export function configEnvPath(configDir = resolveConfigDir()): string {
  return path.join(configDir, ".env");
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeDotEnv(entries: Record<string, string>): string {
  const lines = [
    "# Managed by Joshu last30days app — do not store browser cookies or XAI/Xquik keys here.",
    "# YouTube uses ScrapeCreators (no yt-dlp). Web uses keyless DuckDuckGo.",
    "",
  ];
  for (const key of ALLOWED_CONFIG_KEYS) {
    const value = entries[key];
    if (value === undefined || value === "") continue;
    // Escape newlines / quotes simply
    const safe = value.replace(/\n/g, "\\n");
    if (/[\s#"']/.test(safe)) {
      lines.push(`${key}="${safe.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}=${safe}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function readConfigFile(configDir = resolveConfigDir()): Record<string, string> {
  const file = configEnvPath(configDir);
  if (!fs.existsSync(file)) return {};
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfigFile(
  updates: Record<string, string | undefined | null>,
  configDir = resolveConfigDir(),
): Record<string, string> {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const current = readConfigFile(configDir);
  const next: Record<string, string> = { ...current };

  for (const key of Object.keys(updates)) {
    if ((FORBIDDEN_ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Config key forbidden by Joshu SC-only policy: ${key}`);
    }
    if (!(ALLOWED_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown or unsupported config key: ${key}`);
    }
    const value = updates[key];
    if (
      key === "SCRAPECREATORS_API_KEY" &&
      scrapeCreatorsRelayConfigured() &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      throw new Error("ScrapeCreators API keys cannot be stored in fleet relay mode");
    }
    if (value === undefined || value === null || value === "") {
      delete next[key];
    } else {
      next[key] = String(value);
    }
  }

  // Always scrub forbidden keys if somehow present in the file.
  for (const key of FORBIDDEN_ENV_KEYS) {
    delete next[key];
  }

  const file = configEnvPath(configDir);
  fs.writeFileSync(file, serializeDotEnv(next), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return next;
}

export function maskSecret(value: string | undefined): { present: boolean; last4?: string } {
  if (!value || !value.trim()) return { present: false };
  const trimmed = value.trim();
  return {
    present: true,
    last4: trimmed.length <= 4 ? trimmed : trimmed.slice(-4),
  };
}

function openRouterKeyForBox(
  projectRoot: string,
  fileEnv: Record<string, string>,
): { key: string; source: "provision" | "env" | "local" | "file" | "unset" } {
  const fromFile = fileEnv.OPENROUTER_API_KEY?.trim() || "";
  const fromBox = resolveBoxSecret("OPENROUTER_API_KEY", projectRoot).trim();
  if (fromBox) {
    if (provisionEnvTrim("OPENROUTER_API_KEY") === fromBox) {
      return { key: fromBox, source: "provision" };
    }
    const base = joshuConfigDir(projectRoot);
    const localPath = base ? path.join(base, "box-secrets", "local-env.json") : "";
    if (localPath && fs.existsSync(localPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>;
        if (typeof parsed.OPENROUTER_API_KEY === "string" && parsed.OPENROUTER_API_KEY.trim() === fromBox) {
          return { key: fromBox, source: "local" };
        }
      } catch {
        /* ignore */
      }
    }
    if (fromFile && fromFile === fromBox) return { key: fromBox, source: "file" };
    return { key: fromBox, source: "env" };
  }
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: "unset" };
}

/**
 * Reasoning credentials for the vendored engine subprocess.
 * Prod/fleet: OpenRouter from per-box provision or Welcome (never host Gemini).
 */
export function resolveReasoningEnv(
  projectRoot: string,
  fileEnv: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const { key: openrouter } = openRouterKeyForBox(projectRoot, fileEnv);
  if (openrouter) {
    out.OPENROUTER_API_KEY = openrouter;
    out.LAST30DAYS_REASONING_PROVIDER = "openrouter";
    // Engine default OPENROUTER_DEFAULT ends in `-preview` and 404s on OpenRouter;
    // pin the same slug Hindsight/Hermes aux LLM uses on fleet boxes.
    out.LAST30DAYS_PLANNER_MODEL =
      fileEnv.LAST30DAYS_PLANNER_MODEL?.trim() || JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL;
    out.LAST30DAYS_RERANK_MODEL =
      fileEnv.LAST30DAYS_RERANK_MODEL?.trim() || JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL;
  }
  const perplexity = fileEnv.PERPLEXITY_API_KEY?.trim();
  if (perplexity) out.PERPLEXITY_API_KEY = perplexity;
  return out;
}

/**
 * Exa for engine grounding — provisioned via CP (minted or shared) → instance.env
 * `EXA_API_KEY`. Not a Welcome box-secret UI key; App Settings file may override.
 */
export function resolveExaApiKey(
  projectRoot: string,
  fileEnv: Record<string, string> = {},
): { key: string; source: "provision" | "env" | "file" | "unset" } {
  void projectRoot;
  const fromFile = fileEnv.EXA_API_KEY?.trim() || "";
  const fromProvision = provisionEnvTrim("EXA_API_KEY");
  if (fromProvision) return { key: fromProvision, source: "provision" };
  const fromProcess = process.env.EXA_API_KEY?.trim() || "";
  if (fromProcess) {
    if (fromFile && fromFile === fromProcess) return { key: fromProcess, source: "file" };
    return { key: fromProcess, source: "env" };
  }
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: "unset" };
}

/** Engine `--web-backend` token for Joshu desktop app. */
export function resolveWebBackendChoice(
  projectRoot: string,
  fileEnv: Record<string, string> = {},
): "exa" | "keyless" {
  return resolveExaApiKey(projectRoot, fileEnv).key ? "exa" : "keyless";
}

/** Fleet ScrapeCreators shipping mode from provision env / process env. */
export function resolveScrapeCreatorsMode(): ScrapeCreatorsMode {
  const fromProvision = (provisionEnvTrim("JOSHU_SCRAPECREATORS_MODE") || "").toLowerCase();
  if (fromProvision === "relay" || fromProvision === "direct" || fromProvision === "off") {
    return fromProvision;
  }
  const fromProcess = (process.env.JOSHU_SCRAPECREATORS_MODE || "").trim().toLowerCase();
  if (fromProcess === "relay" || fromProcess === "direct" || fromProcess === "off") {
    return fromProcess;
  }
  return "direct";
}

export function scrapeCreatorsRelayConfigured(): boolean {
  const mode = resolveScrapeCreatorsMode();
  if (mode !== "relay") return false;
  const relayUrl =
    provisionEnvTrim("JOSHU_SCRAPECREATORS_RELAY_URL") ||
    process.env.JOSHU_SCRAPECREATORS_RELAY_URL?.trim() ||
    "";
  return Boolean(relayUrl);
}

/**
 * Child-process env for ScrapeCreators relay (no vendor key on disk).
 * Uses instance-agent Bearer via http.py shim.
 */
export function resolveScrapeCreatorsRelayEnv(): Record<string, string> {
  if (!scrapeCreatorsRelayConfigured()) return {};
  const relayUrl =
    provisionEnvTrim("JOSHU_SCRAPECREATORS_RELAY_URL") ||
    process.env.JOSHU_SCRAPECREATORS_RELAY_URL?.trim() ||
    "";
  const out: Record<string, string> = {
    JOSHU_SCRAPECREATORS_MODE: "relay",
    JOSHU_SCRAPECREATORS_RELAY_URL: relayUrl,
    // Sentinel — upstream availability checks; http.py ignores for auth.
    SCRAPECREATORS_API_KEY: SCRAPECREATORS_RELAY_SENTINEL,
  };
  const instanceId =
    provisionEnvTrim("JOSHU_INSTANCE_ID") || process.env.JOSHU_INSTANCE_ID?.trim() || "";
  const agentToken =
    provisionEnvTrim("INSTANCE_AGENT_TOKEN") || process.env.INSTANCE_AGENT_TOKEN?.trim() || "";
  if (instanceId) out.JOSHU_INSTANCE_ID = instanceId;
  if (agentToken) out.INSTANCE_AGENT_TOKEN = agentToken;
  const cpUrl = provisionEnvTrim("CONTROL_PLANE_URL") || process.env.CONTROL_PLANE_URL?.trim() || "";
  if (cpUrl) out.CONTROL_PLANE_URL = cpUrl;
  return out;
}

export function pickInheritedProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

export function publicConfigView(
  entries: Record<string, string>,
  projectRoot = process.cwd(),
): Record<string, unknown> {
  const relayActive = scrapeCreatorsRelayConfigured();
  const scFromFile = maskSecret(entries.SCRAPECREATORS_API_KEY);
  const sc = relayActive
    ? { present: true, relay: true as const }
    : scFromFile;
  const or = openRouterKeyForBox(projectRoot, entries);
  const reasoningProvider = or.key ? "openrouter" : "local";
  const exa = resolveExaApiKey(projectRoot, entries);
  const webBackend = exa.key ? "exa" : "keyless";
  return {
    setupComplete: entries.SETUP_COMPLETE === "1" || entries.SETUP_COMPLETE === "true",
    includeSources: entries.INCLUDE_SOURCES || "",
    excludeSources: entries.EXCLUDE_SOURCES || "",
    memoryDir: entries.LAST30DAYS_MEMORY_DIR || path.join(os.homedir(), "Documents", "Last30Days"),
    store: entries.LAST30DAYS_STORE === "1" || entries.LAST30DAYS_STORE === "true",
    register: entries.LAST30DAYS_REGISTER || "default",
    defaultSearch: entries.LAST30DAYS_DEFAULT_SEARCH || "",
    corpusDirs: entries.LAST30DAYS_CORPUS_DIRS || "",
    scrapecreators: sc,
    scrapecreatorsRelay: {
      mode: resolveScrapeCreatorsMode(),
      configured: relayActive,
    },
    openrouter: maskSecret(or.key),
    exa: { ...maskSecret(exa.key), source: exa.source },
    perplexity: maskSecret(entries.PERPLEXITY_API_KEY),
    reasoning: {
      provider: reasoningProvider,
      openrouterSource: or.source,
      plannerModel:
        or.key
          ? entries.LAST30DAYS_PLANNER_MODEL?.trim() || JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL
          : null,
      rerankModel:
        or.key
          ? entries.LAST30DAYS_RERANK_MODEL?.trim() || JOSHU_OPENROUTER_HINDSIGHT_LLM_MODEL
          : null,
      note:
        reasoningProvider === "openrouter"
          ? "Planner/rerank via OpenRouter (per-box key)"
          : "No OpenRouter key — planner/rerank use deterministic/local scoring",
    },
    bluesky: {
      handle: entries.BSKY_HANDLE || "",
      appPassword: maskSecret(entries.BSKY_APP_PASSWORD),
    },
    truthsocial: maskSecret(entries.TRUTHSOCIAL_TOKEN),
    policy: {
      web: webBackend,
      youtube: relayActive || scFromFile.present ? "scrapecreators" : "scrapecreators-unconfigured",
      scrapecreators: relayActive ? "relay" : scFromFile.present ? "direct" : "unset",
      x: "disabled-no-cookies",
      cookies: false,
      ytdlp: false,
      reasoning: reasoningProvider,
    },
  };
}

/**
 * Build a PATH that excludes directories containing a `yt-dlp` binary.
 * Ensures the engine falls through to ScrapeCreators YouTube.
 */
export function sanitizePathNoYtdlp(originalPath = process.env.PATH || ""): string {
  const sep = path.delimiter;
  const parts = originalPath.split(sep).filter(Boolean);
  const kept: string[] = [];
  for (const dir of parts) {
    try {
      const candidateUnix = path.join(dir, "yt-dlp");
      const candidateWin = path.join(dir, "yt-dlp.exe");
      if (fs.existsSync(candidateUnix) || fs.existsSync(candidateWin)) {
        continue;
      }
    } catch {
      /* keep dir on probe errors */
    }
    kept.push(dir);
  }
  return kept.join(sep);
}

export function resolveEngineRoot(projectRoot: string): string {
  return path.join(projectRoot, "integrations", "last30days-skill");
}

export function resolveEngineScript(projectRoot: string): string {
  return path.join(
    resolveEngineRoot(projectRoot),
    "skills",
    "last30days",
    "scripts",
    "last30days.py",
  );
}

export function resolveCompanionScript(
  projectRoot: string,
  name: "watchlist.py" | "store.py" | "briefing.py",
): string {
  return path.join(
    resolveEngineRoot(projectRoot),
    "skills",
    "last30days",
    "scripts",
    name,
  );
}

/** True when a python binary resolves on PATH or as an absolute path. */
function pythonBinRunnable(bin: string): boolean {
  const trimmed = bin.trim();
  if (!trimmed) return false;
  if (trimmed.includes(path.sep)) return fs.existsSync(trimmed);
  const probe = spawnSync(trimmed, ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

/** Prefer LAST30DAYS_PYTHON when present on disk, then python3.13 / 3.12 / 3.14, then python3. */
export function resolvePythonBin(): string {
  const candidates = [
    process.env.LAST30DAYS_PYTHON,
    "python3.13",
    "python3.12",
    "python3.14",
    "python3",
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const bin of candidates) {
    if (pythonBinRunnable(bin)) return bin;
  }
  return "python3";
}
