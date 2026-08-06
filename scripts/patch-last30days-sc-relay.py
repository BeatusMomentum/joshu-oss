#!/usr/bin/env python3
"""
Apply Joshu ScrapeCreators relay shim to the vendored last30days-skill http.py.

When JOSHU_SCRAPECREATORS_MODE=relay, api.scrapecreators.com requests are forwarded
to the control plane proxy instead of using a local x-api-key.

Idempotent — safe to re-run after sync-last30days-skill.sh.
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = "# --- joshu sc-relay shim (do not edit; re-applied by patch-last30days-sc-relay.py) ---"

RELAY_HELPERS = '''
# --- joshu sc-relay shim (do not edit; re-applied by patch-last30days-sc-relay.py) ---
_SC_UPSTREAM_HOST = "api.scrapecreators.com"


def _sc_relay_enabled() -> bool:
    mode = (os.environ.get("JOSHU_SCRAPECREATORS_MODE") or "").strip().lower()
    if mode != "relay":
        return False
    return bool((os.environ.get("JOSHU_SCRAPECREATORS_RELAY_URL") or "").strip())


def _sc_relay_bearer() -> str:
    instance_id = (os.environ.get("JOSHU_INSTANCE_ID") or "").strip()
    raw = (os.environ.get("INSTANCE_AGENT_TOKEN") or "").strip()
    if not instance_id or not raw:
        raise HTTPError(
            "ScrapeCreators relay requires JOSHU_INSTANCE_ID and INSTANCE_AGENT_TOKEN",
            outcome_state=health.AUTH_FAILED,
        )
    if raw.startswith(f"{instance_id}."):
        return raw
    return f"{instance_id}.{raw}"


def _sc_relay_request(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]],
    json_data: Optional[Dict[str, Any]],
    params: Optional[Dict[str, Any]],
    timeout: int,
    retries: int,
    max_429_retries: int,
    raw: bool,
) -> Union[Dict[str, Any], str]:
    """Forward one ScrapeCreators call via Joshu control-plane proxy."""
    relay_url = (os.environ.get("JOSHU_SCRAPECREATORS_RELAY_URL") or "").strip()
    parts = urlsplit(url)
    if parts.netloc != _SC_UPSTREAM_HOST:
        raise HTTPError(f"ScrapeCreators relay misconfigured for host: {parts.netloc}")

    path = parts.path or "/"
    query = parts.query or ""
    if params:
        filtered = {k: str(v) for k, v in params.items() if v is not None}
        if filtered:
            extra = urlencode(filtered)
            query = f"{query}&{extra}" if query else extra

    payload: Dict[str, Any] = {"method": method.upper(), "path": path}
    if query:
        payload["query"] = query
    if json_data is not None:
        payload["json"] = json_data

    fixture_request = _fixture_request(method, url, json_data, raw)
    fixture_redactions = _fixture_redactions(url, headers or {}, json_data)

    last_error: Optional[HTTPError] = None
    effective_retries = max(retries, MIN_DNS_RETRIES)
    attempt = 0
    while attempt < effective_retries:
        try:
            req = urllib.request.Request(
                relay_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {_sc_relay_bearer()}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": USER_AGENT,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                envelope = json.loads(body) if body else {}
                if not isinstance(envelope, dict):
                    raise HTTPError("ScrapeCreators relay returned non-object JSON")

                if not envelope.get("ok"):
                    msg = str(envelope.get("message") or envelope.get("error") or "relay failed")
                    raise HTTPError(
                        f"ScrapeCreators relay: {msg}",
                        outcome_state=health.UNREACHABLE,
                    )

                upstream_status = envelope.get("status")
                if isinstance(upstream_status, int) and upstream_status >= 400:
                    err = HTTPError(
                        f"HTTP {upstream_status}: ScrapeCreators upstream error",
                        upstream_status,
                    )
                    if upstream_status == 429 and attempt < effective_retries - 1:
                        time.sleep(RETRY_DELAY * (2 ** attempt))
                        attempt += 1
                        last_error = err
                        continue
                    _fixture_record(fixture_request, error=err, redactions=fixture_redactions)
                    _raise(err)

                if raw:
                    raw_text = envelope.get("raw")
                    if isinstance(raw_text, str):
                        _fixture_record(fixture_request, value=raw_text, redactions=fixture_redactions)
                        return raw_text
                    if envelope.get("json") is not None:
                        as_text = json.dumps(envelope.get("json"))
                        _fixture_record(fixture_request, value=as_text, redactions=fixture_redactions)
                        return as_text
                    _fixture_record(fixture_request, value="", redactions=fixture_redactions)
                    return ""

                if envelope.get("json") is not None:
                    parsed = envelope.get("json")
                    if isinstance(parsed, dict):
                        _fixture_record(fixture_request, value=parsed, redactions=fixture_redactions)
                        return parsed
                    if isinstance(parsed, list):
                        _fixture_record(fixture_request, value={"data": parsed}, redactions=fixture_redactions)
                        return {"data": parsed}
                if isinstance(envelope.get("raw"), str) and envelope.get("raw"):
                    try:
                        parsed = json.loads(envelope["raw"])
                        _fixture_record(fixture_request, value=parsed, redactions=fixture_redactions)
                        return parsed
                    except json.JSONDecodeError:
                        _fixture_record(fixture_request, value=envelope["raw"], redactions=fixture_redactions)
                        return envelope["raw"]
                _fixture_record(fixture_request, value={}, redactions=fixture_redactions)
                return {}
        except HTTPError:
            raise
        except urllib.error.HTTPError as e:
            body = None
            try:
                body = e.read().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                pass
            last_error = HTTPError(f"ScrapeCreators relay HTTP {e.code}: {e.reason}", e.code, body)
            if attempt < effective_retries - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
                attempt += 1
                continue
            _fixture_record(fixture_request, error=last_error, redactions=fixture_redactions)
            _raise(last_error)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = HTTPError(f"ScrapeCreators relay URL error: {e}")
            if attempt < effective_retries - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
                attempt += 1
                continue
            _fixture_record(fixture_request, error=last_error, redactions=fixture_redactions)
            _raise(last_error)
        except json.JSONDecodeError as e:
            err = HTTPError(f"ScrapeCreators relay invalid JSON: {e}", outcome_state=health.SCHEMA_DRIFT)
            _fixture_record(fixture_request, error=err, redactions=fixture_redactions)
            _raise(err)
        attempt += 1

    if last_error:
        _fixture_record(fixture_request, error=last_error, redactions=fixture_redactions)
        _raise(last_error)
    err = HTTPError("ScrapeCreators relay failed with no error details")
    _fixture_record(fixture_request, error=err, redactions=fixture_redactions)
    _raise(err)
# --- end joshu sc-relay shim ---
'''

INTERCEPT = '''
    if _sc_relay_enabled():
        try:
            parts = urlsplit(url)
            if parts.netloc == _SC_UPSTREAM_HOST:
                return _sc_relay_request(
                    method,
                    url,
                    headers,
                    json_data,
                    params,
                    timeout,
                    retries,
                    max_429_retries,
                    raw,
                )
        except HTTPError:
            raise
'''


def patch_http_py(http_path: Path) -> None:
    text = http_path.read_text(encoding="utf-8")
    if MARKER in text:
        # Strip prior shim block and re-apply cleanly.
        start = text.index(MARKER)
        end_marker = "# --- end joshu sc-relay shim ---"
        end = text.index(end_marker) + len(end_marker)
        text = text[:start].rstrip() + "\n\n" + text[end:].lstrip()

    anchor = "def request("
    if anchor not in text:
        raise SystemExit(f"patch anchor not found in {http_path}")

    if "    headers = headers or {}" not in text:
        raise SystemExit(f"expected headers bootstrap missing in {http_path}")

    text = text.replace(
        "def request(",
        RELAY_HELPERS + "\n\ndef request(",
        1,
    )
    text = text.replace(
        '    headers.setdefault("User-Agent", USER_AGENT)\n',
        '    headers.setdefault("User-Agent", USER_AGENT)\n' + INTERCEPT,
        1,
    )

    http_path.write_text(text, encoding="utf-8")
    print(f"[patch-last30days-sc-relay] patched {http_path}")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    http_path = (
        root
        / "integrations"
        / "last30days-skill"
        / "skills"
        / "last30days"
        / "scripts"
        / "lib"
        / "http.py"
    )
    if not http_path.is_file():
        print(f"[patch-last30days-sc-relay] skip — missing {http_path}", file=sys.stderr)
        return 0
    patch_http_py(http_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
