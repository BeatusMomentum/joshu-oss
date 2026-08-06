#!/usr/bin/env python3
"""
Generate voice-realtime instant think-ack PCM from the box S2S voice config.

- gemini_live: Gemini TTS (Interactions API) with GEMINI_LIVE_VOICE / JOSHU_VOICE_ID
- openai: OpenAI /v1/audio/speech with OPENAI_REALTIME_VOICE / JOSHU_VOICE_ID

Output: PCM16 mono @ 24 kHz, base64 file for voice-realtime (browser_audio_out path).

Requires: python3, ffmpeg on PATH (joshu sandbox image has it).
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OPENAI_TTS_VOICES = frozenset(
    {
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "fable",
        "onyx",
        "nova",
        "sage",
        "shimmer",
        "verse",
        "marin",
        "cedar",
    }
)


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_dotenv_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def load_env() -> None:
    root = repo_root()
    load_dotenv_file(root / ".env")
    load_dotenv_file(Path("/etc/joshu/instance.env"))


def read_identity_voice_id() -> str | None:
    aroz_data = env("AROZ_DATA") or str(repo_root() / ".local" / "arozos-data")
    users_root = Path(aroz_data) / "files" / "users"
    if not users_root.is_dir():
        return None
    override = env("JOSHU_AROZ_USER")
    candidates: list[str] = []
    if override:
        candidates = [override]
    else:
        for ent in sorted(users_root.iterdir()):
            if ent.is_dir() and ent.name != "admin":
                candidates.append(ent.name)
    for user in candidates:
        identity = users_root / user / ".joshu" / "identity.json"
        if not identity.is_file():
            continue
        try:
            data = json.loads(identity.read_text(encoding="utf-8"))
            voice = data.get("voiceId")
            if isinstance(voice, str) and voice.strip():
                return voice.strip()
        except (json.JSONDecodeError, OSError):
            continue
    return None


def resolve_provider() -> str:
    raw = env("JOSHU_VOICE_PROVIDER", "openai").lower()
    return "gemini_live" if raw == "gemini_live" else "openai"


def resolve_voice_id(provider: str) -> str:
    for key in ("JOSHU_VOICE_ID",):
        v = env(key)
        if v:
            return v
    identity_voice = read_identity_voice_id()
    if identity_voice:
        return identity_voice
    if provider == "gemini_live":
        return env("GEMINI_LIVE_VOICE", "Kore")
    return env("OPENAI_REALTIME_VOICE", "alloy")


def resolve_phrase() -> str:
    return env("VOICE_INSTANT_PROGRESS_ACK", "One moment.")


def resolve_output_path() -> Path:
    explicit = env("VOICE_INSTANT_ACK_PCM_PATH")
    if explicit:
        return Path(explicit)
    aroz_data = env("AROZ_DATA") or str(repo_root() / ".local" / "arozos-data")
    users_root = Path(aroz_data) / "files" / "users"
    override = env("JOSHU_AROZ_USER")
    user_dirs: list[str] = [override] if override else []
    if users_root.is_dir():
        if not user_dirs:
            user_dirs = sorted(
                p.name
                for p in users_root.iterdir()
                if p.is_dir() and p.name != "admin"
            )
        for user in user_dirs:
            out_dir = users_root / user / ".joshu" / "voice"
            return out_dir / "instant-progress-ack.pcm.b64"
    return repo_root() / "packages" / "voice-realtime" / "dist" / "instant-progress-ack.pcm.b64"


def map_openai_voice(voice_id: str) -> str:
    v = voice_id.strip().lower()
    if v in OPENAI_TTS_VOICES:
        return v
    print(
        f"[generate-voice-instant-ack] WARN: OpenAI TTS has no voice {voice_id!r}; using alloy",
        file=sys.stderr,
    )
    return "alloy"


def synthesize_gemini(phrase: str, voice: str) -> bytes:
    api_key = (
        env("GEMINI_API_KEY")
        or env("GOOGLE_API_KEY")
        or env("GOOGLE_GENAI_API_KEY")
    )
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) required for gemini_live")

    model = env("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
    body = {
        "contents": [{"parts": [{"text": phrase}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}},
            },
        },
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={urllib.parse.quote(api_key, safe='')}"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Gemini TTS HTTP {e.code}: {detail}") from e

    parts = (
        payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [])
    )
    for part in parts:
        inline = part.get("inlineData") if isinstance(part, dict) else None
        if not isinstance(inline, dict):
            continue
        data_b64 = inline.get("data")
        mime = str(inline.get("mimeType", ""))
        if isinstance(data_b64, str) and data_b64:
            raw = base64.b64decode(data_b64)
            if "pcm" in mime.lower() or "L16" in mime:
                return raw
            return raw

    raise RuntimeError(
        f"Gemini TTS response missing audio inlineData: {list(payload.keys())}",
    )


def synthesize_openai(phrase: str, voice: str) -> bytes:
    api_key = env("OPENAI_API_KEY") or env("VOICE_TOOLS_OPENAI_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY required for openai voice provider")

    model = env("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    body = {
        "model": model,
        "input": phrase,
        "voice": map_openai_voice(voice),
        "response_format": "pcm",
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"OpenAI TTS HTTP {e.code}: {detail}") from e


def ffmpeg_to_pcm24k(audio_bytes: bytes, suffix: str) -> bytes:
    ffmpeg = env("FFMPEG_BIN", "ffmpeg")
    with tempfile.TemporaryDirectory(prefix="joshu-voice-ack-") as tmp:
        src = Path(tmp) / f"in{suffix}"
        dst = Path(tmp) / "out.pcm"
        src.write_bytes(audio_bytes)
        proc = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "24000",
                str(dst),
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip() or proc.stdout.strip()}")
        return dst.read_bytes()


def ensure_pcm24k(raw: bytes) -> bytes:
    """Gemini interactions may return WAV or raw PCM — normalize to s16le 24k mono."""
    if len(raw) >= 4 and raw[:4] == b"RIFF":
        return ffmpeg_to_pcm24k(raw, ".wav")
    # OpenAI pcm is already 24k s16le mono; Gemini may return raw pcm at 24k.
    if len(raw) % 2 != 0:
        raw = raw[: len(raw) - 1]
    return raw


def main() -> int:
    load_env()
    provider = resolve_provider()
    voice = resolve_voice_id(provider)
    phrase = resolve_phrase()
    out_path = resolve_output_path()

    print(
        f"[generate-voice-instant-ack] provider={provider} voice={voice!r} "
        f"phrase={phrase!r} out={out_path}",
        file=sys.stderr,
    )

    if provider == "gemini_live":
        audio = synthesize_gemini(phrase, voice)
    else:
        audio = synthesize_openai(phrase, voice)

    pcm = ensure_pcm24k(audio)
    if len(pcm) < 100:
        raise RuntimeError(f"generated PCM too small ({len(pcm)} bytes)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    b64 = base64.b64encode(pcm).decode("ascii")
    out_path.write_text(b64 + "\n", encoding="utf-8")

    meta_path = out_path.with_suffix(".json")
    meta_path.write_text(
        json.dumps(
            {
                "phrase": phrase,
                "provider": provider,
                "voice": voice,
                "pcmBytes": len(pcm),
                "path": str(out_path),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(json.dumps({"ok": True, "path": str(out_path), "pcmBytes": len(pcm)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1) from exc
