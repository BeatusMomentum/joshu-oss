/**
 * Smoke test: fleet relay mode must never treat provision/process FAL_KEY as usable.
 */
import assert from "node:assert/strict";

function resolveFalMode(env) {
  const fromProvision = (env.JOSHU_FAL_MODE || "").trim().toLowerCase();
  if (fromProvision === "off") return "off";
  if (fromProvision === "direct") return "direct";
  if (fromProvision === "relay") return "relay";
  return "direct";
}

function resolveFalApiKey(env, fileConfig = {}) {
  const mode = resolveFalMode(env);
  if (mode === "relay" || mode === "off") return "";
  const fromFile = (fileConfig.FAL_KEY || "").trim();
  if (fromFile) return fromFile;
  return (env.FAL_KEY || env.FAL_API_KEY || "").trim();
}

assert.equal(
  resolveFalApiKey(
    {
      JOSHU_FAL_MODE: "relay",
      FAL_KEY: "cp-default-key-must-not-leak",
    },
    {},
  ),
  "",
);

assert.equal(
  resolveFalApiKey(
    {
      JOSHU_FAL_MODE: "direct",
      FAL_KEY: "process-env-key",
    },
    {},
  ),
  "process-env-key",
);

assert.equal(
  resolveFalApiKey(
    { JOSHU_FAL_MODE: "direct" },
    { FAL_KEY: "connectors-file-key" },
  ),
  "connectors-file-key",
);

console.log("metered provider fal key isolation tests passed");
