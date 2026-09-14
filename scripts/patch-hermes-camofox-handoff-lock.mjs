#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/browser_camofox.py to call Joshu browser-handoff lock
 * before navigate/click/type/press/back while owner mobile handoff is pending.
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-camofox-handoff-lock.mjs <path/to/browser_camofox.py>");
  process.exit(1);
}

const MARKER = "hitl_browser_handoff_lock";

const helperBlock = `
def _joshu_browser_handoff_base() -> str:
    return (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )


def _joshu_browser_handoff_lock_check() -> Optional[str]:
    \"\"\"Return a tool_error JSON string when owner mobile handoff holds the browser lock (${MARKER}).\"\"\"
    base = _joshu_browser_handoff_base()
    try:
        resp = requests.get(f"{base}/api/browser-handoff/lock", timeout=10)
        payload = resp.json() if resp.content else {}
    except Exception as exc:
        logger.warning("Joshu browser handoff lock check failed: %s", exc)
        return None
    if resp.status_code >= 400:
        logger.warning("Joshu browser handoff lock HTTP %s: %s", resp.status_code, payload)
        return None
    if not payload.get("locked"):
        return None
    stub = {
        "success": False,
        "error": "browser_handoff_locked",
        "message": (
            "Browser is locked for owner mobile handoff. "
            "Wait for browser_handoff_status=completed before navigating or clicking."
        ),
        "handoffId": payload.get("handoffId"),
        "pageUrl": payload.get("pageUrl"),
        "instructions": payload.get("instructions"),
    }
    return json.dumps(stub)
`;

const lockNeedle = `    lock_err = _joshu_browser_handoff_lock_check()
    if lock_err:
        return lock_err
`;

function wrapFunction(source, fnName) {
  const needle = `def ${fnName}(`;
  if (!source.includes(needle)) {
    console.error(`[hermes-patch] ${fnName}() not found in ${target}`);
    process.exit(1);
  }
  if (source.includes(`def ${fnName}(`) && source.includes(`_joshu_browser_handoff_lock_check()`)) {
    const fnStart = source.indexOf(needle);
    const nextFn = source.indexOf("\ndef ", fnStart + 1);
    const fnBody = source.slice(fnStart, nextFn > fnStart ? nextFn : undefined);
    if (fnBody.includes("_joshu_browser_handoff_lock_check()")) {
      return source;
    }
  }

  const fnStart = source.indexOf(needle);
  const guardNeedle = "    guard_err = _joshu_action_guard_browser(";
  const guardPos = source.indexOf(guardNeedle, fnStart);
  const tryNeedle = "    try:\n        session = _get_session(task_id)";
  const tryPos = source.indexOf(tryNeedle, fnStart);
  if (tryPos === -1) {
    console.error(`[hermes-patch] insertion point not found in ${fnName}()`);
    process.exit(1);
  }

  const insertAt = guardPos !== -1 && guardPos < tryPos ? guardPos : tryPos;
  if (source.slice(fnStart, insertAt).includes("_joshu_browser_handoff_lock_check()")) {
    return source;
  }
  return source.slice(0, insertAt) + lockNeedle + source.slice(insertAt);
}

let source = readFileSync(target, "utf8");

if (source.includes(MARKER) && source.includes("_joshu_browser_handoff_lock_check")) {
  console.log("[hermes-patch] Camofox browser-handoff lock patch already applied.");
  process.exit(0);
}

if (!source.includes("def _get_session(")) {
  console.error(`[hermes-patch] _get_session() not found in ${target}`);
  process.exit(1);
}

const insertAfter = "logger = logging.getLogger(__name__)";
if (!source.includes(insertAfter)) {
  console.error(`[hermes-patch] logger anchor not found in ${target}`);
  process.exit(1);
}

if (!source.includes("_joshu_browser_handoff_lock_check")) {
  source = source.replace(insertAfter, `${insertAfter}\n${helperBlock}`);
}

for (const fnName of ["camofox_navigate", "camofox_click", "camofox_type", "camofox_press", "camofox_back"]) {
  source = wrapFunction(source, fnName);
}

writeFileSync(target, source);
console.log("[hermes-patch] applied Camofox browser-handoff lock patch — restart Hermes gateway");
