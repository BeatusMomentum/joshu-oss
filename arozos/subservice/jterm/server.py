#!/usr/bin/env python3
"""
jTerm — ArozOS subservice: static UI + interactive PTY over WebSocket.

Launched by ArozOS with: -port :NNNN -rpt http://localhost:PARENT/api/ajgi/interface

Uses only the Python standard library so it runs on local Mac and VPS images
without native Node addons. Auth is ArozOS (subservice reverse-proxy + session).
"""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import pty
import select
import struct
import sys
import termios
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

APP_NAME = "joshu-jterm"
STATIC_DIR = Path(os.environ.get("AROZ_STATIC_DIR", Path(__file__).resolve().parent / "app"))
SHELL = os.environ.get("JTERM_SHELL", os.environ.get("SHELL", "/bin/bash"))
# Soft default cwd; still full container FS access once the shell starts.
DEFAULT_CWD = os.environ.get("JTERM_CWD", "/root")
HERMES_BIN = os.environ.get("HERMES_BIN", "/opt/hermes-agent/venv/bin/hermes")
HERMES_DIR = os.environ.get("HERMES_DIR", "/opt/hermes-agent")
HERMES_HOME = os.environ.get("HERMES_HOME", "/root/.hermes")


def parse_args(argv: list[str]) -> int:
    port = 8799
    i = 0
    while i < len(argv):
        if argv[i] == "-port" and i + 1 < len(argv):
            raw = argv[i + 1].lstrip(":")
            port = int(raw)
            i += 2
            continue
        if argv[i] == "-rpt" and i + 1 < len(argv):
            i += 2
            continue
        i += 1
    return port


def content_type(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }.get(ext, "application/octet-stream")


def resolve_static(url_path: str) -> Optional[Path]:
    decoded = unquote(url_path.split("?", 1)[0] or "/")
    relative = "index.html" if decoded in ("", "/") else decoded.lstrip("/")
    requested = (STATIC_DIR / relative).resolve()
    try:
        requested.relative_to(STATIC_DIR.resolve())
    except ValueError:
        return None
    if requested.is_dir():
        candidate = requested / "index.html"
        return candidate if candidate.is_file() else None
    if requested.is_file():
        return requested
    # SPA fallback
    index = STATIC_DIR / "index.html"
    return index if index.is_file() else None


def ws_accept_key(sec_key: str) -> str:
    guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    digest = hashlib.sha1((sec_key + guid).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_send(sock, payload: bytes, opcode: int = 0x1) -> None:
    """Send a WebSocket frame (server → client, unmasked)."""
    length = len(payload)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
        header.append(length)
    elif length < (1 << 16):
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    sock.sendall(header + payload)


def ws_recv_frames(sock):
    """Yield (opcode, payload) from a WebSocket client connection."""
    buf = bytearray()

    def read_exact(n: int) -> bytes:
        nonlocal buf
        while len(buf) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket closed")
            buf.extend(chunk)
        out = bytes(buf[:n])
        del buf[:n]
        return out

    while True:
        b1, b2 = read_exact(2)
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", read_exact(8))[0]
        mask = read_exact(4) if masked else b""
        payload = bytearray(read_exact(length))
        if masked:
            for i in range(len(payload)):
                payload[i] ^= mask[i % 4]
        yield opcode, bytes(payload)


def build_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    home = "/root" if os.path.isdir("/root") else env.get("HOME", str(Path.home()))
    env.setdefault("HOME", home)
    env.setdefault("HERMES_HOME", HERMES_HOME)
    env.setdefault("HERMES_DIR", HERMES_DIR)
    env.setdefault("HERMES_BIN", HERMES_BIN)
    # Put Hermes CLI + bun on PATH when present.
    path_parts = [p for p in env.get("PATH", "").split(":") if p]
    extras: list[str] = []
    hermes_bin_dir = str(Path(HERMES_BIN).parent) if HERMES_BIN else ""
    if hermes_bin_dir and Path(hermes_bin_dir).is_dir() and hermes_bin_dir not in path_parts:
        extras.append(hermes_bin_dir)
    # Also try the image default even if HERMES_BIN points elsewhere / missing.
    default_hermes_dir = "/opt/hermes-agent/venv/bin"
    if default_hermes_dir not in extras and default_hermes_dir not in path_parts:
        if Path(default_hermes_dir, "hermes").exists():
            extras.append(default_hermes_dir)
    bun = str(Path(home) / ".bun" / "bin")
    if Path(bun).is_dir() and bun not in path_parts and bun not in extras:
        extras.append(bun)
    if extras:
        env["PATH"] = ":".join(extras + path_parts)
    return env


def write_bash_rcfile(env: dict[str, str]) -> Path:
    """
    Login shells (`bash -l`) reset PATH from /etc/profile and drop Hermes.
    Use an interactive non-login shell with a small rcfile instead: keep our PATH,
    then source the user's ~/.bashrc when present.
    """
    rc = Path("/tmp/jterm.bashrc")
    path = env.get("PATH", "")
    hermes_bin = env.get("HERMES_BIN", HERMES_BIN)
    lines = [
        "# Generated by jTerm — do not edit",
        f'export PATH={json.dumps(path)}',
        f'export HERMES_BIN={json.dumps(hermes_bin)}',
        f'export HERMES_HOME={json.dumps(env.get("HERMES_HOME", HERMES_HOME))}',
        f'export HERMES_DIR={json.dumps(env.get("HERMES_DIR", HERMES_DIR))}',
        'export TERM="${TERM:-xterm-256color}"',
        # Convenience alias if PATH is still wrong for any reason
        f'alias hermes={json.dumps(hermes_bin)}',
        'if [ -f "$HOME/.bashrc" ]; then',
        '  # shellcheck disable=SC1090',
        '  . "$HOME/.bashrc"',
        "fi",
        # Re-assert PATH after bashrc (some profiles overwrite it)
        f'export PATH={json.dumps(path)}',
        "",
    ]
    rc.write_text("\n".join(lines), encoding="utf-8")
    return rc


def set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def run_pty_session(sock) -> None:
    cwd = DEFAULT_CWD if os.path.isdir(DEFAULT_CWD) else os.getcwd()
    env = build_env()
    shell = SHELL if os.path.isfile(SHELL) or SHELL.startswith("/") else "/bin/bash"
    if not os.path.exists(shell):
        shell = "/bin/sh"

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: interactive shell with Hermes on PATH
        try:
            os.chdir(cwd)
        except OSError:
            pass
        basename = os.path.basename(shell)
        if "bash" in basename:
            rcfile = write_bash_rcfile(env)
            # Interactive, non-login — avoids /etc/profile PATH wipe from `bash -l`
            os.execvpe(shell, [shell, "--rcfile", str(rcfile), "-i"], env)
        else:
            os.execvpe(shell, [shell], env)
        os._exit(127)

    set_winsize(master_fd, 24, 80)
    stop = threading.Event()

    def pump_pty_to_ws() -> None:
        try:
            while not stop.is_set():
                r, _, _ = select.select([master_fd], [], [], 0.2)
                if not r:
                    continue
                try:
                    data = os.read(master_fd, 8192)
                except OSError:
                    break
                if not data:
                    break
                ws_send(sock, data, opcode=0x2)  # binary
        except Exception:
            pass
        finally:
            stop.set()
            try:
                ws_send(sock, b"", opcode=0x8)
            except Exception:
                pass

    reader = threading.Thread(target=pump_pty_to_ws, name="jterm-pty-out", daemon=True)
    reader.start()

    try:
        for opcode, payload in ws_recv_frames(sock):
            if stop.is_set():
                break
            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping
                ws_send(sock, payload, opcode=0xA)
                continue
            if opcode in (0x1, 0x2):  # text or binary
                # Text frames: JSON control ({type:resize}) or raw input
                if opcode == 0x1:
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                    except Exception:
                        os.write(master_fd, payload)
                        continue
                    if isinstance(msg, dict) and msg.get("type") == "resize":
                        set_winsize(master_fd, int(msg.get("rows") or 24), int(msg.get("cols") or 80))
                        continue
                    if isinstance(msg, dict) and msg.get("type") == "input":
                        data = msg.get("data", "")
                        if isinstance(data, str) and data:
                            os.write(master_fd, data.encode("utf-8", errors="replace"))
                        continue
                    # Unknown JSON — ignore
                    continue
                os.write(master_fd, payload)
    except Exception:
        pass
    finally:
        stop.set()
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        try:
            sock.close()
        except Exception:
            pass


class JTermHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[{APP_NAME}] {self.address_string()} - {fmt % args}\n")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in ("/ws", "/jterm/ws") or parsed.path.endswith("/ws"):
            self._handle_ws()
            return
        self._serve_static(parsed.path)

    def _serve_static(self, url_path: str) -> None:
        file_path = resolve_static(url_path)
        if not file_path:
            self.send_error(404, "Not found")
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type(file_path))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_ws(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            self.send_error(400, "Expected WebSocket upgrade")
            return
        accept = ws_accept_key(key)
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        # Detach the raw socket from the HTTP handler
        sock = self.connection
        try:
            self.close_connection = True
            run_pty_session(sock)
        except Exception as exc:
            sys.stderr.write(f"[{APP_NAME}] pty session error: {exc}\n")


def main() -> None:
    port = parse_args(sys.argv[1:])
    if not STATIC_DIR.is_dir():
        sys.stderr.write(f"[{APP_NAME}] missing static dir: {STATIC_DIR}\n")
        sys.exit(1)
    server = ThreadingHTTPServer(("127.0.0.1", port), JTermHandler)
    sys.stderr.write(
        f"[{APP_NAME}] serving {STATIC_DIR} + PTY ws on 127.0.0.1:{port} "
        f"(shell={SHELL} cwd={DEFAULT_CWD})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
