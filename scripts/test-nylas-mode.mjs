/**
 * Mode resolution + relay URL/bearer helpers (no live Nylas / CP calls).
 *   npx tsx scripts/test-nylas-mode.mjs
 */
import assert from "node:assert/strict";
import {
  isNylasConfigured,
  parseNylasModeEnv,
  resolveNylasMode,
} from "../src/nylas/config.ts";
import {
  nylasProxyBearerToken,
  nylasProxyCall,
  nylasProxyUrl,
} from "../src/nylas/relayTransport.ts";

function env(partial) {
  return { ...partial };
}

assert.equal(parseNylasModeEnv("relay"), "relay");
assert.equal(parseNylasModeEnv("DIRECT"), "direct");
assert.equal(parseNylasModeEnv("off"), "off");
assert.equal(parseNylasModeEnv(""), null);
assert.equal(parseNylasModeEnv("nope"), null);

// OSS default: key present, no mode → direct
assert.equal(resolveNylasMode(env({ NYLAS_API_KEY: "nyk_test" })), "direct");
assert.equal(isNylasConfigured(env({ NYLAS_API_KEY: "nyk_test" })), true);

// Explicit off wins even with key
assert.equal(
  resolveNylasMode(env({ JOSHU_NYLAS_MODE: "off", NYLAS_API_KEY: "nyk_test" })),
  "off",
);
assert.equal(
  isNylasConfigured(env({ JOSHU_NYLAS_MODE: "off", NYLAS_API_KEY: "nyk_test" })),
  false,
);

// Explicit relay without CP creds → not configured
assert.equal(resolveNylasMode(env({ JOSHU_NYLAS_MODE: "relay" })), "relay");
assert.equal(isNylasConfigured(env({ JOSHU_NYLAS_MODE: "relay" })), false);

// Relay with CP creds
const relayEnv = env({
  JOSHU_NYLAS_MODE: "relay",
  CONTROL_PLANE_URL: "https://hello.joshu.me",
  JOSHU_INSTANCE_ID: "inst_abc",
  INSTANCE_AGENT_TOKEN: "rawtok",
});
assert.equal(resolveNylasMode(relayEnv), "relay");
assert.equal(isNylasConfigured(relayEnv), true);
assert.equal(nylasProxyUrl(relayEnv), "https://hello.joshu.me/api/instances/nylas/proxy");
assert.equal(nylasProxyBearerToken(relayEnv), "inst_abc.rawtok");

// Token already prefixed
assert.equal(
  nylasProxyBearerToken(
    env({
      JOSHU_INSTANCE_ID: "inst_abc",
      INSTANCE_AGENT_TOKEN: "inst_abc.rawtok",
    }),
  ),
  "inst_abc.rawtok",
);

// No key, no mode → off (do not auto-relay)
assert.equal(resolveNylasMode(env({})), "off");
assert.equal(isNylasConfigured(env({})), false);

// Explicit direct without key → not configured
assert.equal(isNylasConfigured(env({ JOSHU_NYLAS_MODE: "direct" })), false);

// Relay payload shape
let captured = null;
const fakeFetch = async (input, init) => {
  captured = { url: String(input), init: init || {} };
  return new Response(JSON.stringify({ result: { ok: true } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const result = await nylasProxyCall(
  { op: "listEvents", grantId: "grant_1", args: { limit: 5 } },
  relayEnv,
  fakeFetch,
);
assert.deepEqual(result, { ok: true });
assert.ok(captured);
assert.equal(captured.url, "https://hello.joshu.me/api/instances/nylas/proxy");
const headers = captured.init.headers;
assert.equal(headers.Authorization, "Bearer inst_abc.rawtok");
const body = JSON.parse(String(captured.init.body));
assert.deepEqual(body, {
  op: "listEvents",
  grantId: "grant_1",
  args: { limit: 5 },
});

console.log("ok: nylas mode + relay transport");
