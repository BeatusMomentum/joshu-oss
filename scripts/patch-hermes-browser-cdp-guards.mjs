#!/usr/bin/env node
/**
 * Patch Hermes tools/browser_tool.py so the built-in CDP/local browser tools
 * honor Joshu's handoff lock and browser write gate.
 *
 * Inserted after the Camofox early-return, so Camofox mode keeps using the
 * existing browser_camofox.py patches and is not checked twice.
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-browser-cdp-guards.mjs <path/to/browser_tool.py>");
  process.exit(1);
}

const MARKER = "hitl_browser_cdp_guards";

const helperBlock = `
def _joshu_browser_cdp_base() -> str:
    return (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )


def _joshu_browser_handoff_lock_check() -> Optional[str]:
    """Return a tool_error JSON string when owner mobile handoff holds the browser lock (${MARKER})."""
    base = _joshu_browser_cdp_base()
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


def _joshu_browser_guard_enabled() -> bool:
    return os.getenv("JOSHU_ACTION_GUARD_BROWSER_GATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _joshu_action_guard_browser(kind: str, args: Dict[str, Any]) -> Optional[str]:
    """Return a tool_error JSON string when the owner denied or timed out (${MARKER})."""
    if not _joshu_browser_guard_enabled():
        return None
    base = _joshu_browser_cdp_base()
    try:
        resp = requests.post(
            f"{base}/api/action-guard/browser",
            json={"kind": kind, "args": args},
            timeout=60 * 30,
        )
        payload = resp.json() if resp.content else {}
    except Exception as exc:
        logger.warning("Joshu browser action guard failed: %s", exc)
        return None
    if resp.status_code >= 400:
        logger.warning("Joshu browser action guard HTTP %s: %s", resp.status_code, payload)
        return None
    if payload.get("allowed") is True:
        return None
    stub = payload.get("stub")
    if isinstance(stub, dict):
        return json.dumps(stub)
    return json.dumps({"success": True})
`;

const lockNeedle = `    lock_err = _joshu_browser_handoff_lock_check()
    if lock_err:
        return lock_err
`;

function guardNeedle(kind, argBuilder) {
  return `    guard_err = _joshu_action_guard_browser("${kind}", ${argBuilder})
    if guard_err:
        return guard_err
`;
}

function insertAfterCamofoxReturn(source, fnName, callee, insertion) {
  const fnStart = source.indexOf(`def ${fnName}(`);
  if (fnStart < 0) {
    console.error(`[hermes-patch] ${fnName}() not found in ${target}`);
    process.exit(1);
  }
  const nextFn = source.indexOf("\ndef ", fnStart + 1);
  const fnEnd = nextFn > fnStart ? nextFn : source.length;
  const fnBody = source.slice(fnStart, fnEnd);
  if (fnBody.includes("_joshu_browser_handoff_lock_check()")) return source;
  const marker = `return ${callee}(`;
  const ret = fnBody.indexOf(marker);
  if (ret < 0) {
    console.error(`[hermes-patch] ${callee}() return not found in ${fnName}()`);
    process.exit(1);
  }
  const lineEnd = fnBody.indexOf("\n", ret);
  const abs = fnStart + lineEnd + 1;
  return source.slice(0, abs) + insertion + source.slice(abs);
}

let source = readFileSync(target, "utf8");

if (source.includes(MARKER) && source.includes("_joshu_browser_handoff_lock_check")) {
  console.log("[hermes-patch] CDP browser handoff lock already applied.");
  process.exit(0);
}

const loggerAnchor = "logger = logging.getLogger(__name__)";
if (!source.includes(loggerAnchor)) {
  console.error(`[hermes-patch] logger anchor not found in ${target}`);
  process.exit(1);
}
if (!source.includes("_joshu_browser_handoff_lock_check")) {
  source = source.replace(loggerAnchor, `${loggerAnchor}\n${helperBlock}`);
}

source = insertAfterCamofoxReturn(source, "browser_navigate", "camofox_navigate", lockNeedle);
source = insertAfterCamofoxReturn(
  source,
  "browser_click",
  "camofox_click",
  lockNeedle + guardNeedle("click", '{"ref": ref, "url": ""}'),
);
source = insertAfterCamofoxReturn(
  source,
  "browser_type",
  "camofox_type",
  lockNeedle + guardNeedle("type", '{"ref": ref, "text": text}'),
);
source = insertAfterCamofoxReturn(source, "browser_back", "camofox_back", lockNeedle);
source = insertAfterCamofoxReturn(
  source,
  "browser_press",
  "camofox_press",
  lockNeedle + guardNeedle("press", '{"key": key}'),
);

writeFileSync(target, source);
console.log("[hermes-patch] applied CDP browser handoff lock — restart Hermes gateway");
