import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIRECT_LLM_ENV_KEYS,
  FORBIDDEN_ENV_KEYS,
  resolveReasoningEnv,
  resolveScrapeCreatorsRelayEnv,
  scrapeCreatorsRelayConfigured,
  SCRAPECREATORS_RELAY_SENTINEL,
  resolveXquikRelayEnv,
  xquikRelayConfigured,
  XQUIK_RELAY_SENTINEL,
  sanitizePathNoYtdlp,
  writeConfigFile,
  resolveLast30DaysEngine,
} from "../src/last30days/config.ts";
import { buildHardenedEnv, hardenArgv } from "../src/last30days/runner.ts";
import {
  formatCompactCount,
  indexClustersForDisplay,
  nativeStatsLabel,
  preferredNativeCounter,
  agentReportToMarkdown,
  filterItemsForDisplay,
  isOffTopicEventItem,
  DEFAULT_RELEVANCE_FLOOR,
} from "../src/last30days/agentReportFormat.ts";
import { registerFromArgv } from "../src/last30days/audienceRegister.ts";
import {
  appendWatchSnapshot,
  computeWatchTrend,
  snapshotFromReport,
} from "../src/last30days/watchSnapshots.ts";
import { filterWatchingForCadence } from "../src/last30days/watching.ts";
import {
  applyQueryPlanBundle,
  buildHeuristicQueryPlan,
  classifyTopic,
  filterPlanSources,
  shouldApplyQueryPlan,
  stripTrailingCalendarYear,
} from "../src/last30days/queryPlan.ts";
import {
  last30daysRunsDir,
  last30daysStateDir,
  last30daysConfigDir,
  last30daysShareDir,
  last30daysMemoryDir,
  migrateLegacyLast30daysState,
} from "../src/last30days/statePaths.ts";
import { defaultConfigDir, defaultMemoryDir, resolveConfigDir } from "../src/last30days/config.ts";
import { buildAppInvokeCronScript } from "../src/appCronSync.ts";
import { writeBoxSecretsOverrides } from "../src/boxSecrets/localEnv.ts";

function testSanitizePath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-path-"));
  const withYt = path.join(tmp, "with-yt");
  const without = path.join(tmp, "clean");
  fs.mkdirSync(withYt);
  fs.mkdirSync(without);
  fs.writeFileSync(path.join(withYt, "yt-dlp"), "#!/bin/sh\n", { mode: 0o755 });
  const sanitized = sanitizePathNoYtdlp([withYt, without].join(path.delimiter));
  assert.ok(!sanitized.split(path.delimiter).includes(withYt), "yt-dlp dir removed");
  assert.ok(sanitized.split(path.delimiter).includes(without), "clean dir kept");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("ok sanitizePathNoYtdlp");
}

function testHardenArgv() {
  const a = hardenArgv(["topic"]);
  assert.ok(a.includes("--no-browser-cookies"));
  assert.ok(a.some((x) => x.includes("web-backend=keyless")));
  const b = hardenArgv(["topic", "--web-backend=none", "--no-browser-cookies"]);
  assert.equal(b.filter((x) => x.includes("web-backend")).length, 1);
  const c = hardenArgv(["topic"], { env: { EXA_API_KEY: "exa-test" } });
  assert.ok(c.some((x) => x.includes("web-backend=exa")));
  console.log("ok hardenArgv");
}

function testForbiddenConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-cfg-"));
  try {
    assert.throws(() => {
      writeConfigFile({ FROM_BROWSER: "auto" }, dir);
    });
    writeConfigFile(
      {
        SCRAPECREATORS_API_KEY: "test-key-abcd",
        INCLUDE_SOURCES: "tiktok,instagram,youtube_comments",
        SETUP_COMPLETE: "1",
      },
      dir,
    );
    const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
    for (const key of FORBIDDEN_ENV_KEYS) {
      assert.ok(!text.includes(`${key}=`), `must not persist ${key}`);
    }
    assert.ok(text.includes("SCRAPECREATORS_API_KEY="));
    console.log("ok forbidden config scrub");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testReasoningEnvIsolation() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-reason-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-cfgdir-"));
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevArozUser = process.env.JOSHU_AROZ_USER;
  const prevArozData = process.env.AROZ_DATA;
  try {
    process.env.GEMINI_API_KEY = "host-gemini-should-not-leak";
    delete process.env.OPENROUTER_API_KEY;

    const envNoOr = buildHardenedEnv(projectRoot, configDir);
    for (const key of DIRECT_LLM_ENV_KEYS) {
      assert.equal(envNoOr[key], undefined, `${key} must not leak from host`);
    }
    assert.equal(envNoOr.OPENROUTER_API_KEY, undefined);
    assert.equal(envNoOr.LAST30DAYS_REASONING_PROVIDER, undefined);

    const arozData = path.join(projectRoot, ".local", "arozos-data");
    process.env.AROZ_DATA = arozData;
    process.env.JOSHU_AROZ_USER = "testuser";
    fs.mkdirSync(path.join(arozData, "files", "users", "testuser"), { recursive: true });
    writeBoxSecretsOverrides({ OPENROUTER_API_KEY: "sk-or-box-test-key" }, projectRoot);

    const reasoning = resolveReasoningEnv(projectRoot, {});
    assert.equal(reasoning.LAST30DAYS_REASONING_PROVIDER, "openrouter");
    assert.equal(reasoning.OPENROUTER_API_KEY, "sk-or-box-test-key");
    assert.equal(reasoning.LAST30DAYS_PLANNER_MODEL, "google/gemini-3.1-flash-lite");
    assert.equal(reasoning.LAST30DAYS_RERANK_MODEL, "google/gemini-3.1-flash-lite");

    const envWithOr = buildHardenedEnv(projectRoot, configDir);
    assert.equal(envWithOr.OPENROUTER_API_KEY, "sk-or-box-test-key");
    assert.equal(envWithOr.LAST30DAYS_REASONING_PROVIDER, "openrouter");
    assert.equal(envWithOr.GEMINI_API_KEY, undefined);
    console.log("ok reasoning env isolation");
  } finally {
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;
    if (prevArozUser === undefined) delete process.env.JOSHU_AROZ_USER;
    else process.env.JOSHU_AROZ_USER = prevArozUser;
    if (prevArozData === undefined) delete process.env.AROZ_DATA;
    else process.env.AROZ_DATA = prevArozData;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

testSanitizePath();
testHardenArgv();
testForbiddenConfig();
testReasoningEnvIsolation();
testExaEnvPassThrough();
testScRelayEnv();
testXquikRelayEnv();
testNativeEngagement();
testWatchTrend();
testWatchCadenceFilter();
testWatchlistCronScript();
testWatchingSkillSupport();
testWritingStyleMarkdown();
testQueryPlan();
testLast30daysStatePaths();
testEngineResolution();
console.log("all last30days config/runner unit checks passed");

function testExaEnvPassThrough() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-exa-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-cfgdir-"));
  const prevExa = process.env.EXA_API_KEY;
  try {
    process.env.EXA_API_KEY = "exa-box-test-key";
    assert.ok(!FORBIDDEN_ENV_KEYS.includes("EXA_API_KEY"), "EXA must not be forbidden");

    const env = buildHardenedEnv(projectRoot, configDir);
    assert.equal(env.EXA_API_KEY, "exa-box-test-key");
    assert.equal(env.BRAVE_API_KEY, undefined);
    const argv = hardenArgv(["topic"], { projectRoot, configDir, env });
    assert.ok(argv.some((x) => x.includes("web-backend=exa")));
    console.log("ok exa env pass-through");
  } finally {
    if (prevExa === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = prevExa;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function testScRelayEnv() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-relay-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-cfg-relay-"));
  const prevMode = process.env.JOSHU_SCRAPECREATORS_MODE;
  const prevRelayUrl = process.env.JOSHU_SCRAPECREATORS_RELAY_URL;
  const prevInstanceId = process.env.JOSHU_INSTANCE_ID;
  const prevAgentToken = process.env.INSTANCE_AGENT_TOKEN;
  const prevScKey = process.env.SCRAPECREATORS_API_KEY;
  try {
    writeConfigFile(
      {
        SCRAPECREATORS_API_KEY: "local-file-key-should-not-win",
        INCLUDE_SOURCES: "tiktok",
        SETUP_COMPLETE: "1",
      },
      configDir,
    );

    process.env.JOSHU_SCRAPECREATORS_MODE = "relay";
    process.env.JOSHU_SCRAPECREATORS_RELAY_URL =
      "https://hello.joshu.me/api/instances/scrapecreators/proxy";
    process.env.JOSHU_INSTANCE_ID = "inst-test";
    process.env.INSTANCE_AGENT_TOKEN = "tok-test";
    delete process.env.SCRAPECREATORS_API_KEY;

    assert.equal(scrapeCreatorsRelayConfigured(), true);
    const relayEnv = resolveScrapeCreatorsRelayEnv();
    assert.equal(relayEnv.SCRAPECREATORS_API_KEY, SCRAPECREATORS_RELAY_SENTINEL);
    assert.equal(relayEnv.JOSHU_SCRAPECREATORS_MODE, "relay");

    const env = buildHardenedEnv(projectRoot, configDir);
    assert.equal(env.SCRAPECREATORS_API_KEY, SCRAPECREATORS_RELAY_SENTINEL);
    assert.equal(env.JOSHU_SCRAPECREATORS_RELAY_URL, relayEnv.JOSHU_SCRAPECREATORS_RELAY_URL);

    assert.throws(() => {
      writeConfigFile({ SCRAPECREATORS_API_KEY: "must-not-store" }, configDir);
    });

    console.log("ok sc relay env");
  } finally {
    if (prevMode === undefined) delete process.env.JOSHU_SCRAPECREATORS_MODE;
    else process.env.JOSHU_SCRAPECREATORS_MODE = prevMode;
    if (prevRelayUrl === undefined) delete process.env.JOSHU_SCRAPECREATORS_RELAY_URL;
    else process.env.JOSHU_SCRAPECREATORS_RELAY_URL = prevRelayUrl;
    if (prevInstanceId === undefined) delete process.env.JOSHU_INSTANCE_ID;
    else process.env.JOSHU_INSTANCE_ID = prevInstanceId;
    if (prevAgentToken === undefined) delete process.env.INSTANCE_AGENT_TOKEN;
    else process.env.INSTANCE_AGENT_TOKEN = prevAgentToken;
    if (prevScKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = prevScKey;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function testXquikRelayEnv() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-xquik-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-cfg-xquik-"));
  const prevMode = process.env.JOSHU_XQUIK_MODE;
  const prevRelayUrl = process.env.JOSHU_XQUIK_RELAY_URL;
  const prevInstanceId = process.env.JOSHU_INSTANCE_ID;
  const prevAgentToken = process.env.INSTANCE_AGENT_TOKEN;
  const prevKey = process.env.XQUIK_API_KEY;
  try {
    process.env.JOSHU_XQUIK_MODE = "relay";
    process.env.JOSHU_XQUIK_RELAY_URL = "https://hello.joshu.me/api/instances/xquik/proxy";
    process.env.JOSHU_INSTANCE_ID = "inst-test";
    process.env.INSTANCE_AGENT_TOKEN = "tok-test";
    process.env.XQUIK_API_KEY = "host-shell-key-must-not-leak";

    assert.equal(xquikRelayConfigured(), true);
    const relayEnv = resolveXquikRelayEnv();
    assert.equal(relayEnv.XQUIK_API_KEY, XQUIK_RELAY_SENTINEL);
    assert.equal(relayEnv.LAST30DAYS_X_BACKEND, "xquik");

    const env = buildHardenedEnv(projectRoot, configDir);
    assert.equal(env.XQUIK_API_KEY, XQUIK_RELAY_SENTINEL);
    assert.equal(env.LAST30DAYS_X_BACKEND, "xquik");
    assert.equal(env.XAI_API_KEY, undefined);

    assert.throws(() => {
      writeConfigFile({ XQUIK_API_KEY: "must-not-store" }, configDir);
    });

    console.log("ok xquik relay env");
  } finally {
    if (prevMode === undefined) delete process.env.JOSHU_XQUIK_MODE;
    else process.env.JOSHU_XQUIK_MODE = prevMode;
    if (prevRelayUrl === undefined) delete process.env.JOSHU_XQUIK_RELAY_URL;
    else process.env.JOSHU_XQUIK_RELAY_URL = prevRelayUrl;
    if (prevInstanceId === undefined) delete process.env.JOSHU_INSTANCE_ID;
    else process.env.JOSHU_INSTANCE_ID = prevInstanceId;
    if (prevAgentToken === undefined) delete process.env.INSTANCE_AGENT_TOKEN;
    else process.env.INSTANCE_AGENT_TOKEN = prevAgentToken;
    if (prevKey === undefined) delete process.env.XQUIK_API_KEY;
    else process.env.XQUIK_API_KEY = prevKey;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function testNativeEngagement() {
  assert.equal(formatCompactCount(4200), "4.2k");
  assert.equal(formatCompactCount(1_200_000), "1.2M");
  const reddit = preferredNativeCounter("reddit", { score: 150, comments: 40 });
  assert.equal(reddit.unit, "upvotes");
  assert.equal(reddit.value, 150);
  const yt = preferredNativeCounter("youtube", { views: 2_500_000, likes: 12 });
  assert.equal(yt.unit, "views");
  const mixed = nativeStatsLabel([
    { source: "reddit", engagement: { score: 150 }, cluster: 0 },
    { source: "youtube", engagement: { views: 2_500_000 }, cluster: 0 },
  ]);
  assert.ok(mixed.includes("upvotes"), mixed);
  assert.ok(mixed.includes("views"), mixed);
  assert.ok(!mixed.includes(" eng"), mixed);

  // Without relevance scores, engagement still orders clusters.
  const indexed = indexClustersForDisplay(
    [{ title: "views-heavy", engagement_total: 2_500_150 }, { title: "reddit-heavy", engagement_total: 900 }],
    [
      { source: "youtube", engagement: { views: 2_500_000 }, cluster: 0 },
      { source: "reddit", engagement: { score: 150 }, cluster: 0 },
      { source: "reddit", engagement: { score: 400 }, cluster: 1 },
      { source: "hackernews", engagement: { points: 500 }, cluster: 1 },
    ],
  );
  assert.equal(indexed.length, 2);
  assert.ok(indexed[0].nativeLabel);

  // Relevance beats raw engagement: viral off-topic loses to quieter on-topic.
  const byRelevance = indexClustersForDisplay(
    [{ title: "noise" }, { title: "signal" }],
    [
      {
        source: "reddit",
        title: "flower carpet week",
        engagement: { score: 1600 },
        relevance_score: 0.2,
        cluster: 0,
      },
      {
        source: "x",
        title: "LA Tech Week hosts",
        engagement: { views: 60 },
        relevance_score: 0.6,
        cluster: 1,
      },
    ],
  );
  assert.equal(byRelevance[0]?.cluster.title, "signal");

  // Floor drops low-relevance items (and their clusters).
  const floored = filterItemsForDisplay(
    [
      { title: "keep", relevance_score: 0.55, cluster: 0 },
      { title: "drop", relevance_score: 0.3, cluster: 1 },
    ],
    { relevanceFloor: DEFAULT_RELEVANCE_FLOOR },
  );
  assert.equal(floored.length, 1);
  assert.equal(floored[0]?.title, "keep");

  assert.equal(
    isOffTopicEventItem(
      { title: "Colombia Tech Week conversamos sobre IA" },
      "LA Tech Week 2026",
    ),
    true,
  );
  assert.equal(
    isOffTopicEventItem(
      { title: "Hosting for LA Tech Week at UCLA" },
      "LA Tech Week 2026",
    ),
    false,
  );

  const eventFiltered = indexClustersForDisplay(
    [{ title: "colombia" }, { title: "la" }],
    [
      {
        title: "Colombia Tech Week",
        relevance_score: 0.7,
        engagement: { views: 9000 },
        cluster: 0,
      },
      {
        title: "LA Tech Week hosts",
        relevance_score: 0.55,
        engagement: { views: 50 },
        cluster: 1,
      },
    ],
    { query: "LA Tech Week 2026" },
  );
  assert.equal(eventFiltered.length, 1);
  assert.equal(eventFiltered[0]?.cluster.title, "la");

  console.log("ok native engagement");
}

function testWatchTrend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-snap-"));
  try {
    const report = {
      query: "Acme",
      window_days: 7,
      generated_at: "2026-01-01T00:00:00.000Z",
      results: [
        { source: "reddit", url: "https://r/1", engagement: { score: 10 } },
        { source: "reddit", url: "https://r/2", engagement: { score: 12 } },
      ],
    };
    const snap = snapshotFromReport(report, { topic: "Acme", runId: "run-1", windowDays: 7 });
    assert.equal(snap.mentionCount, 2);
    appendWatchSnapshot(dir, snap);
    assert.equal(computeWatchTrend([snap]).kind, "building");

    const snaps = [];
    for (let i = 0; i < 4; i += 1) {
      const n = i < 3 ? 6 : 20;
      snaps.push({
        topic: "Acme",
        runId: `r${i}`,
        generatedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
        windowDays: 7,
        mentionCount: n,
        comparableEngagement: n * 2,
        sources: { reddit: { itemCount: n, nativeTotal: n * 10, unit: "upvotes" } },
        urls: Array.from({ length: n }, (_, k) => `https://r/${i}-${k}`),
        clusterTitles: [],
      });
    }
    const trend = computeWatchTrend(snaps);
    assert.equal(trend.kind, "trending", trend.label);
    console.log("ok watch trend");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testWatchCadenceFilter() {
  const rows = [
    { name: "daily-a", cadence: "daily", enabled: true },
    { name: "weekly-a", cadence: "weekly", enabled: true },
    { name: "off", cadence: "daily", enabled: false },
  ];
  assert.deepEqual(
    filterWatchingForCadence(rows).map((r) => r.name),
    ["daily-a", "weekly-a"],
  );
  assert.deepEqual(
    filterWatchingForCadence(rows, "daily").map((r) => r.name),
    ["daily-a"],
  );
  assert.deepEqual(
    filterWatchingForCadence(rows, "weekly").map((r) => r.name),
    ["weekly-a"],
  );
  console.log("ok watch cadence filter");
}

function testWatchlistCronScript() {
  const script = buildAppInvokeCronScript({
    appId: "last30days",
    action: "watchlistRunAll",
    args: { cadence: "daily" },
  });
  assert.ok(script.startsWith("#!/usr/bin/env bash"));
  assert.ok(script.includes("/api/apps/last30days/invoke"));
  assert.ok(script.includes('"cadence":"daily"'));
  console.log("ok watchlist cron script");
}

/** Plugin tools, invoke aliases, and chat skill must stay on the same contract. */
function testWatchingSkillSupport() {
  const root = path.resolve(import.meta.dirname, "..");
  const plugin = fs.readFileSync(path.join(root, ".hermes/plugins/joshu-last30days/tools.py"), "utf8");
  const chatSkill = fs.readFileSync(
    path.join(root, "arozos/subservice/last30days/skills/last30days-chat/SKILL.md"),
    "utf8",
  );
  const guiSkill = fs.readFileSync(
    path.join(root, "arozos/subservice/last30days/skills/last30days-gui/SKILL.md"),
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "arozos/subservice/last30days/joshu.app.json"), "utf8"),
  );
  const invokeRegistry = fs.readFileSync(path.join(root, "src/appInvokeRegistry.ts"), "utf8");

  const tools = [
    "last30days_research",
    "last30days_watch_list",
    "last30days_watch_add",
    "last30days_watch_remove",
    "last30days_watch_report",
    "last30days_watch_run",
    "last30days_watch_run_all",
  ];
  const invokeActions = [
    "watchingList",
    "watchingAdd",
    "watchingRemove",
    "watchingReport",
    "watchingRun",
    "watchingRunAll",
  ];

  for (const name of tools) {
    assert.ok(plugin.includes(`name="${name}"`) || plugin.includes(`"${name}"`), `plugin registers ${name}`);
    assert.ok(chatSkill.includes(`**\`${name}\`**`) || chatSkill.includes(name), `chat skill documents ${name}`);
  }
  const actionNames = (manifest.agent?.actions ?? []).map((a) => a.name);
  for (const action of invokeActions) {
    assert.ok(actionNames.includes(action), `manifest agent.actions includes ${action}`);
    assert.ok(plugin.includes(action), `plugin invoke constant mentions ${action}`);
  }
  assert.ok(invokeRegistry.includes('"watchingList"'), "GET invoke maps watchingList");
  assert.ok(invokeRegistry.includes('"watchingReport"'), "GET invoke maps watchingReport");
  assert.ok(invokeRegistry.includes('"watchingRun"'), "async invoke maps watchingRun");
  assert.ok(invokeRegistry.includes('"watchingRunAll"'), "async invoke maps watchingRunAll");
  assert.ok(guiSkill.includes("last30days_watch_add"), "gui skill documents headless watch add");

  const chatDesc = chatSkill.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  assert.ok(chatDesc.length > 0 && chatDesc.length <= 60, `chat skill description ≤60 chars, got ${chatDesc.length}`);
  const guiDesc = guiSkill.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  assert.ok(guiDesc.length > 0 && guiDesc.length <= 60, `gui skill description ≤60 chars, got ${guiDesc.length}`);
  console.log("ok watching skill/plugin contract");
}

function sampleReport() {
  return {
    query: "Acme",
    window_days: 7,
    clusters: [
      { title: "GitHub stars", sources: ["github"] },
      { title: "TikTok buzz", sources: ["tiktok"] },
      { title: "HN thread", sources: ["hackernews"] },
      { title: "Reddit chat", sources: ["reddit"] },
      { title: "YouTube recap", sources: ["youtube"] },
      { title: "Sixth cluster", sources: ["web"] },
    ],
    results: [
      { title: "repo", source: "github", url: "https://gh/1", cluster: 0, engagement: { stars: 80 } },
      { title: "dance", source: "tiktok", url: "https://tt/1", cluster: 1, engagement: { views: 9000 } },
      { title: "show hn", source: "hackernews", url: "https://hn/1", cluster: 2, engagement: { points: 40 } },
      { title: "thread", source: "reddit", url: "https://r/1", cluster: 3, engagement: { score: 20 } },
      { title: "video", source: "youtube", url: "https://yt/1", cluster: 4, engagement: { views: 5000 } },
      { title: "article", source: "web", url: "https://w/1", cluster: 5, engagement: { score: 1 } },
      {
        title: "yt comment",
        source: "youtube_comments",
        url: "https://yt/c/1",
        cluster: 4,
        engagement: { likes: 12 },
      },
    ],
  };
}

function testWritingStyleMarkdown() {
  assert.equal(registerFromArgv(["python", "last30days.py", "t", "--register=exec"]), "exec");
  assert.equal(registerFromArgv(["python", "last30days.py", "t"]), "default");

  const report = sampleReport();
  const def = agentReportToMarkdown(report);
  assert.ok(def.startsWith("# Acme"));
  assert.ok(def.includes("sorted by relevance"));
  assert.ok(!def.includes("Executive brief"));
  assert.ok(def.includes("Sixth cluster"));

  const exec = agentReportToMarkdown(report, { register: "exec" });
  assert.ok(exec.includes("Executive style"));
  assert.ok(exec.includes("Executive brief"));
  assert.ok(!exec.includes("Sixth cluster"), "exec budgets clusters to 5");
  const execStatsAt = exec.indexOf("github");
  const execClusterAt = exec.indexOf("## 1.");
  assert.ok(execStatsAt >= 0 && execClusterAt > execStatsAt, "exec puts stats before clusters");

  const creator = agentReportToMarkdown(report, { register: "creator" });
  assert.ok(creator.includes("## Best takes"));
  assert.ok(creator.includes("## Top comments"));
  assert.ok(creator.indexOf("Best takes") < creator.indexOf("## 1."), "creator leads with takes");

  const eli5 = agentReportToMarkdown(report, { register: "eli5" });
  assert.ok(eli5.includes("Plain-language brief"));
  assert.ok(eli5.includes("Sixth cluster"));
  console.log("ok writing style markdown");
}

function testQueryPlan() {
  assert.equal(classifyTopic("Google DeepMind"), "named_entity");
  assert.equal(classifyTopic("SpaceXAI"), "named_entity");
  assert.equal(
    classifyTopic("AI value creation private equity operating partners"),
    "concept",
  );
  assert.equal(classifyTopic("Claude vs ChatGPT"), "comparison");
  assert.equal(classifyTopic("LA Tech Week 2026"), "event");
  assert.equal(classifyTopic("SXSW"), "event");
  assert.equal(classifyTopic("Web Summit 2026"), "event");

  assert.deepEqual(stripTrailingCalendarYear("LA Tech Week 2026"), {
    base: "LA Tech Week",
    year: "2026",
  });
  assert.deepEqual(stripTrailingCalendarYear("Google DeepMind"), {
    base: "Google DeepMind",
    year: null,
  });

  assert.equal(filterPlanSources(["x", "jobs", "reddit"], "LA Tech Week").join(","), "x,reddit");
  assert.equal(
    filterPlanSources(["x", "jobs"], "who is hiring AI engineers").includes("jobs"),
    true,
  );

  const eventPlan = buildHeuristicQueryPlan("LA Tech Week 2026");
  assert.equal(eventPlan.kind, "event");
  assert.ok(eventPlan.search?.includes("x"), "event pins X in --search");
  assert.ok(!eventPlan.search?.includes("jobs"), "event excludes jobs");
  assert.equal(eventPlan.plan.subqueries[0]?.search_query, '"LA Tech Week"');
  assert.ok(
    eventPlan.plan.subqueries.some((sq) => sq.search_query.includes("2026")),
    "year kept on a secondary subquery",
  );

  const namedWithYear = buildHeuristicQueryPlan("SpaceXAI 2026");
  assert.equal(namedWithYear.kind, "named_entity");
  assert.ok(namedWithYear.search && !namedWithYear.search.includes("jobs"));
  assert.equal(namedWithYear.plan.subqueries[0]?.search_query, "SpaceXAI");

  assert.equal(shouldApplyQueryPlan({ topic: "foo", mode: "research" }), true);
  assert.equal(shouldApplyQueryPlan({ topic: "foo", mode: "doctor" }), false);
  assert.equal(shouldApplyQueryPlan({ topic: "foo", mock: true }), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-plan-"));
  const planPath = path.join(tmp, "plan.json");
  fs.writeFileSync(planPath, "{}");
  const merged = applyQueryPlanBundle(
    { topic: "AI in PE", quick: true },
    { planPath, search: "reddit,x,grounding", kind: "concept" },
  );
  assert.ok(merged.extraArgs?.some((a) => a === `--plan=${planPath}`));
  assert.equal(merged.search, "reddit,x,grounding");
  assert.equal(merged.quick, false, "concept clears quick default");

  const eventMerged = applyQueryPlanBundle(
    { topic: "LA Tech Week 2026", quick: true },
    {
      planPath,
      search: "grounding,x,reddit,youtube,hackernews",
      kind: "event",
    },
  );
  assert.equal(eventMerged.quick, false, "event clears quick so X is not dropped");

  const namedMerged = applyQueryPlanBundle(
    { topic: "Google DeepMind", quick: true },
    {
      planPath,
      search: "reddit,x,youtube,hackernews,grounding",
      kind: "named_entity",
    },
  );
  assert.equal(namedMerged.quick, false, "named_entity clears quick for multi-angle LLM plans");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("ok queryPlan");
}

function testLast30daysStatePaths() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-state-proj-"));
  const arozData = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-state-aroz-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-state-home-"));
  const user = "owner@example.com";
  const desktop = path.join(arozData, "files", "users", user, "Desktop");
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(path.join(desktop, "joshu's files"), { recursive: true });

  const prevAroz = process.env.AROZ_DATA;
  const prevUser = process.env.JOSHU_AROZ_USER;
  const prevHome = process.env.HOME;
  try {
    process.env.AROZ_DATA = arozData;
    process.env.JOSHU_AROZ_USER = user;
    process.env.HOME = home;

    const state = last30daysStateDir(projectRoot);
    assert.ok(state.includes(path.join("files", "users", user, ".joshu", "last30days")), state);
    assert.ok(last30daysRunsDir(projectRoot).endsWith(path.join("last30days", "runs")));
    assert.equal(last30daysConfigDir(projectRoot), path.join(state, "config"));
    assert.equal(last30daysShareDir(projectRoot), path.join(state, "share"));
    assert.equal(last30daysMemoryDir(projectRoot), path.join(state, "memory"));

    // Legacy overlay FS path → migrate into user tree.
    const legacyRuns = path.join(projectRoot, ".joshu", "last30days", "runs");
    fs.mkdirSync(legacyRuns, { recursive: true });
    fs.writeFileSync(path.join(legacyRuns, "run-1.json"), '{"id":"run-1"}\n');

    // Classic XDG homes → migrate into user tree (write before migrate/symlink).
    const xdgCfg = path.join(home, ".config", "last30days");
    const xdgShare = path.join(home, ".local", "share", "last30days");
    const xdgMem = path.join(home, "Documents", "Last30Days");
    fs.mkdirSync(xdgCfg, { recursive: true });
    fs.mkdirSync(xdgShare, { recursive: true });
    fs.mkdirSync(xdgMem, { recursive: true });
    fs.writeFileSync(path.join(xdgCfg, ".env"), "SETUP_COMPLETE=1\n");
    fs.writeFileSync(path.join(xdgShare, "research.db"), "sqlite-placeholder\n");
    fs.writeFileSync(path.join(xdgMem, "brief.md"), "# brief\n");

    migrateLegacyLast30daysState(projectRoot);
    assert.ok(fs.existsSync(path.join(state, "runs", "run-1.json")), "migrated run into user .joshu");
    assert.ok(fs.existsSync(path.join(state, "config", ".env")), "migrated Settings .env");
    assert.ok(fs.existsSync(path.join(state, "share", "research.db")), "migrated research.db");
    assert.ok(fs.existsSync(path.join(state, "memory", "brief.md")), "migrated memory brief");
    assert.equal(resolveConfigDir(undefined, projectRoot), path.join(state, "config"));
    assert.equal(defaultMemoryDir(projectRoot), path.join(state, "memory"));
    assert.equal(defaultConfigDir(projectRoot), path.join(state, "config"));

    // XDG paths become symlinks to the volume dirs.
    assert.ok(fs.lstatSync(xdgCfg).isSymbolicLink(), "config XDG redirected");
    assert.ok(fs.lstatSync(xdgShare).isSymbolicLink(), "share XDG redirected");
    assert.ok(fs.lstatSync(xdgMem).isSymbolicLink(), "memory XDG redirected");
    console.log("ok last30days state paths");
  } finally {
    if (prevAroz === undefined) delete process.env.AROZ_DATA;
    else process.env.AROZ_DATA = prevAroz;
    if (prevUser === undefined) delete process.env.JOSHU_AROZ_USER;
    else process.env.JOSHU_AROZ_USER = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(arozData, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testEngineResolution() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l30d-eng-"));
  const projectRoot = path.join(tmp, "proj");
  const emptyMount = path.join(projectRoot, "integrations", "last30days-skill");
  const baked = path.join(tmp, "image-skill");
  const envRoot = path.join(tmp, "env-skill");
  const pyRel = path.join("skills", "last30days", "scripts", "last30days.py");
  fs.mkdirSync(emptyMount, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(baked, pyRel)), { recursive: true });
  fs.writeFileSync(path.join(baked, pyRel), "# baked\n");
  fs.mkdirSync(path.dirname(path.join(envRoot, pyRel)), { recursive: true });
  fs.writeFileSync(path.join(envRoot, pyRel), "# env\n");

  const prevImage = process.env.LAST30DAYS_IMAGE_ENGINE_ROOT;
  const prevEngine = process.env.LAST30DAYS_ENGINE_ROOT;
  try {
    delete process.env.LAST30DAYS_ENGINE_ROOT;
    process.env.LAST30DAYS_IMAGE_ENGINE_ROOT = baked;
    const missingMount = resolveLast30DaysEngine(projectRoot);
    assert.equal(missingMount.source, "image", "empty bind-mount must not hide image copy");
    assert.equal(missingMount.present, true);
    assert.equal(missingMount.script, path.join(baked, pyRel));

    process.env.LAST30DAYS_ENGINE_ROOT = envRoot;
    const fromEnv = resolveLast30DaysEngine(projectRoot);
    assert.equal(fromEnv.source, "env");
    assert.equal(fromEnv.root, envRoot);

    fs.mkdirSync(path.dirname(path.join(emptyMount, pyRel)), { recursive: true });
    fs.writeFileSync(path.join(emptyMount, pyRel), "# project\n");
    const fromProject = resolveLast30DaysEngine(projectRoot);
    assert.equal(fromProject.source, "project");
    assert.ok(fromProject.script.startsWith(emptyMount));

    delete process.env.LAST30DAYS_ENGINE_ROOT;
    process.env.LAST30DAYS_IMAGE_ENGINE_ROOT = path.join(tmp, "no-such-image");
    const gone = resolveLast30DaysEngine(path.join(tmp, "no-engine"));
    assert.equal(gone.source, "missing");
    assert.equal(gone.present, false);
    console.log("ok engine resolution fallback");
  } finally {
    if (prevImage === undefined) delete process.env.LAST30DAYS_IMAGE_ENGINE_ROOT;
    else process.env.LAST30DAYS_IMAGE_ENGINE_ROOT = prevImage;
    if (prevEngine === undefined) delete process.env.LAST30DAYS_ENGINE_ROOT;
    else process.env.LAST30DAYS_ENGINE_ROOT = prevEngine;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}