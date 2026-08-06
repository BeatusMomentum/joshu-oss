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
  sanitizePathNoYtdlp,
  writeConfigFile,
} from "../src/last30days/config.ts";
import { buildHardenedEnv, hardenArgv } from "../src/last30days/runner.ts";
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