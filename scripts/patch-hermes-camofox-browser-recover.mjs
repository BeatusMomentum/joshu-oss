#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/browser_camofox.py for generic Camofox browser recovery:
 * - Warm bootstrap via Joshu POST /joshu/api/camofox/warm on tab HTTP failures
 * - Retry navigate once after 404/5xx or proxy-tunnel snapshot text (522 pages)
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-camofox-browser-recover.mjs <path/to/browser_camofox.py>");
  process.exit(1);
}

const MARKER = "hitl_browser_recover";

const helperBlock = `
def _joshu_api_base() -> str:
    return (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )


def _camofox_recoverable_status(status_code: int) -> bool:
    \"\"\"HTTP statuses where Camofox tab/session recovery may help (${MARKER}).\"\"\"
    return status_code in (404, 500, 502, 503, 504)


def _snapshot_text_indicates_proxy_failure(text: str) -> bool:
    \"\"\"Detect proxy/CDN tunnel failure pages that load without throwing goto (${MARKER}).\"\"\"
    sample = (text or "")[:1200].lower()
    if not sample:
        return False
    markers = (
        "proxy server is refusing connections",
        "error code: 522",
        "502 bad gateway or proxy error",
        "camoufox can't establish a connection",
        "unable to connect to the proxy server",
        "ns_error_proxy_connection_refused",
    )
    return any(m in sample for m in markers)


def _joshu_camofox_warm() -> bool:
    \"\"\"Bootstrap shared Camofox tab through Joshu warm endpoint (${MARKER}).\"\"\"
    base = _joshu_api_base()
    try:
        resp = requests.post(f"{base}/api/camofox/warm", timeout=30)
        if resp.status_code >= 400:
            logger.warning("Joshu camofox warm HTTP %s: %s", resp.status_code, resp.text[:200])
            return False
        return bool(resp.json().get("ok", True))
    except Exception as exc:
        logger.warning("Joshu camofox warm failed: %s", exc)
        return False


def _camofox_recover_tab_session(
    session: Dict[str, Any], task_id: Optional[str], browser_url: str
) -> Dict[str, Any]:
    \"\"\"Drop stale tab_id, warm Camofox, and ensure a fresh tab (${MARKER}).\"\"\"
    _joshu_camofox_warm()
    session["tab_id"] = None
    with _sessions_lock:
        _sessions[task_id or "default"] = session
    return _ensure_tab(task_id, browser_url)


def _camofox_post_navigate(session: Dict[str, Any], browser_url: str, timeout: int = 60) -> dict:
    return _post(
        f"/tabs/{session['tab_id']}/navigate",
        {"userId": session["user_id"], "url": browser_url},
        timeout=timeout,
    )
`;

const navigateNeedle = `            except requests.HTTPError as e:
                if e.response is not None and e.response.status_code == 404:
                    logger.warning(
                        "Camofox tab %s returned 404 — tab was garbage collected. "
                        "Creating a fresh tab.",
                        session["tab_id"],
                    )
                    session["tab_id"] = None
                    session = _ensure_tab(task_id, browser_url)
                    data = {"ok": True, "url": browser_url}
                else:
                    raise`;

const navigatePatch = `            except requests.HTTPError as e:
                status = e.response.status_code if e.response is not None else None
                if status is not None and _camofox_recoverable_status(status):
                    logger.warning(
                        "Camofox tab %s returned HTTP %s — warm recover + retry navigate (${MARKER}).",
                        session["tab_id"],
                        status,
                    )
                    session = _camofox_recover_tab_session(session, task_id, browser_url)
                    data = _camofox_post_navigate(session, browser_url)
                else:
                    raise`;

const snapshotNeedle = `            result["snapshot"] = snapshot_text
            result["element_count"] = snap_data.get("refsCount", 0)
        except Exception:
            pass  # Navigation succeeded; snapshot is a bonus`;

const snapshotPatch = `            result["snapshot"] = snapshot_text
            result["element_count"] = snap_data.get("refsCount", 0)
            if _snapshot_text_indicates_proxy_failure(snapshot_text):
                logger.warning(
                    "Camofox snapshot shows proxy tunnel failure on tab %s — warm recover + retry (${MARKER}).",
                    session.get("tab_id"),
                )
                session = _camofox_recover_tab_session(session, task_id, browser_url)
                data = _camofox_post_navigate(session, browser_url)
                snap_data = _get(
                    f"/tabs/{session['tab_id']}/snapshot",
                    params={"userId": session["user_id"]},
                )
                snapshot_text = snap_data.get("snapshot", "")
                from tools.browser_tool import (
                    SNAPSHOT_SUMMARIZE_THRESHOLD,
                    _truncate_snapshot,
                )
                if len(snapshot_text) > SNAPSHOT_SUMMARIZE_THRESHOLD:
                    snapshot_text = _truncate_snapshot(snapshot_text)
                result["snapshot"] = snapshot_text
                result["element_count"] = snap_data.get("refsCount", 0)
                result["url"] = data.get("url", browser_url)
                result["proxy_recovered"] = True
        except Exception:
            pass  # Navigation succeeded; snapshot is a bonus`;

let source = readFileSync(target, "utf8");

if (source.includes(MARKER) && source.includes("_camofox_recover_tab_session")) {
  console.log("[hermes-patch] Camofox browser-recover patch already applied.");
  process.exit(0);
}

if (!source.includes("def camofox_navigate(")) {
  console.error(`[hermes-patch] camofox_navigate() not found in ${target}`);
  process.exit(1);
}

const insertAfter = "logger = logging.getLogger(__name__)";
if (!source.includes(insertAfter)) {
  console.error(`[hermes-patch] logger anchor not found in ${target}`);
  process.exit(1);
}

if (!source.includes("_camofox_recover_tab_session")) {
  source = source.replace(insertAfter, `${insertAfter}\n${helperBlock}`);
}

if (!source.includes(navigateNeedle)) {
  if (source.includes("_camofox_recoverable_status")) {
    console.log("[hermes-patch] Camofox navigate recover block already present.");
  } else {
    console.error(`[hermes-patch] camofox_navigate HTTPError block not found in ${target}`);
    process.exit(1);
  }
} else {
  source = source.replace(navigateNeedle, navigatePatch);
}

if (source.includes(snapshotNeedle)) {
  source = source.replace(snapshotNeedle, snapshotPatch);
} else if (!source.includes("_snapshot_text_indicates_proxy_failure")) {
  console.error(`[hermes-patch] camofox_navigate snapshot block not found in ${target}`);
  process.exit(1);
}

writeFileSync(target, source);
console.log("[hermes-patch] applied Camofox browser-recover patch — restart Hermes gateway");
