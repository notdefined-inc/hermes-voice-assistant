#!/usr/bin/env python3
"""Voice sidecar for the Hermes WebUI voice-assistant extension.

Serves two endpoints that were previously patched into the WebUI source:

  POST /v1/tts           — proxy to the Supertonic TTS server at :7788
  POST /v1/elevenlabs-token — mint a single-use ElevenLabs Realtime STT token
  GET  /health           — health check for the WebUI sidecar proxy

Both endpoints are loopback-only and rely on the WebUI's sidecar proxy
(/api/extensions/voice-assistant/sidecar/<path>) for browser access, so
no API keys are ever exposed to the client.

Usage:
  python3 server.py                    # default port 7789
  python3 server.py --port 7789        # explicit port
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPERTONIC_URL = os.getenv("SUPERTONIC_URL", "http://127.0.0.1:7788/v1/tts")
ELEVENLABS_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe"

# Supertonic TTS response can be large (WAV audio) — allow up to 2 MB.
MAX_TTS_RESPONSE_BYTES = 2 * 1024 * 1024

# ElevenLabs token: max 3 mints per 5s window per client IP.
_TOKEN_RATE_BURST = 3
_TOKEN_RATE_WINDOW = 5.0


# ---------------------------------------------------------------------------
# Rate limiter (thread-safe, same logic as the routes.py patch we replace)
# ---------------------------------------------------------------------------

class _TokenLimiter:
    def __init__(self, max_burst: int, window: float):
        self.max_burst = max_burst
        self.window = window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._checks = 0

    def check(self, client_ip: str) -> bool:
        now = time.time()
        with self._lock:
            self._checks += 1
            if self._checks % 25 == 0:
                cutoff = now - (self.window * 10)
                self._hits = {k: [t for t in v if t > cutoff] for k, v in self._hits.items()}
            hits = [t for t in self._hits.get(client_ip, []) if now - t < self.window]
            if len(hits) >= self.max_burst:
                return False
            hits.append(now)
            self._hits[client_ip] = hits
            return True


_token_limiter = _TokenLimiter(_TOKEN_RATE_BURST, _TOKEN_RATE_WINDOW)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_env_file(key: str) -> str:
    """Read a key from ~/.hermes/.env (same fallback chain as WebUI)."""
    for env_path in (
        Path.home() / ".hermes" / ".env",
        Path(os.getenv("HERMES_HOME", "")) / ".env" if os.getenv("HERMES_HOME") else None,
    ):
        if not env_path or not env_path.is_file():
            continue
        try:
            for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line.startswith(f"{key}="):
                    val = line[len(key) + 1:].strip().strip("'\"")
                    if val:
                        return val
        except Exception:
            pass
    return ""


def _get_elevenlabs_key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if key:
        return key
    return _load_env_file("ELEVENLABS_API_KEY")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class _SidecarHandler(BaseHTTPRequestHandler):
    # Suppress default per-request logging (keeps the journal clean).
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, status: int, body: bytes, content_type: str, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for k, v in headers.items():
                lower = k.lower()
                if lower in ("content-length", "transfer-encoding", "connection"):
                    continue
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_TTS_RESPONSE_BYTES:
            raise ValueError("Request body too large")
        return self.rfile.read(length) if length else b""

    # -- GET /health --------------------------------------------------------
    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "service": "voice-sidecar"})
        else:
            self._send_json(404, {"error": "not found"})

    # -- POST endpoints -----------------------------------------------------
    def do_POST(self):
        if self.path == "/v1/tts":
            self._handle_tts_proxy()
        elif self.path == "/v1/elevenlabs-token":
            self._handle_elevenlabs_token()
        else:
            self._send_json(404, {"error": "not found"})

    # -- Supertonic TTS proxy ----------------------------------------------
    def _handle_tts_proxy(self):
        try:
            raw = self._read_body()
            data = json.loads(raw) if raw else {}
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": f"invalid request body: {exc}"})
            return

        # Forward to the Supertonic server.
        req_body = json.dumps(data).encode("utf-8")
        req = Request(
            SUPERTONIC_URL,
            data=req_body,
            headers={"Content-Type": "application/json", "Accept": "audio/wav"},
        )
        try:
            # No proxy, no redirects — stay on loopback.
            opener = _build_loopback_opener()
            with opener.open(req, timeout=120) as resp:
                audio_data = resp.read(MAX_TTS_RESPONSE_BYTES + 1)
                if len(audio_data) > MAX_TTS_RESPONSE_BYTES:
                    self._send_json(413, {"error": "TTS response too large"})
                    return
            content_type = resp.headers.get("Content-Type", "audio/wav")
            self._send_raw(200, audio_data, content_type)
        except HTTPError as exc:
            # Forward the Supertonic server's error so the extension can react.
            try:
                err_body = exc.read(MAX_TTS_RESPONSE_BYTES + 1)
                self._send_raw(exc.code, err_body, "application/json")
            except Exception:
                self._send_json(exc.code, {"error": f"Supertonic HTTP {exc.code}"})
        except (URLError, OSError, TimeoutError) as exc:
            self._send_json(503, {"error": f"Supertonic unavailable: {exc}"})

    # -- ElevenLabs token mint ---------------------------------------------
    def _handle_elevenlabs_token(self):
        client_ip = self.client_address[0] if self.client_address else "unknown"
        if not _token_limiter.check(client_ip):
            self._send_json(429, {"error": "rate limit exceeded — please wait"})
            return

        api_key = _get_elevenlabs_key()
        if not api_key:
            self._send_json(503, {"error": "ELEVENLABS_API_KEY not configured"})
            return

        try:
            req = Request(
                ELEVENLABS_TOKEN_URL,
                data=b"",
                headers={"xi-api-key": api_key, "Accept": "application/json"},
            )
            with urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8") or "{}")
            token = str(payload.get("token") or "").strip()
            if not token:
                self._send_json(502, {"error": "ElevenLabs token mint failed"})
                return
            self._send_json(200, {"ok": True, "token": token})
        except HTTPError as exc:
            self._send_json(exc.code, {"error": f"ElevenLabs HTTP {exc.code}"})
        except (URLError, OSError, TimeoutError) as exc:
            self._send_json(502, {"error": f"ElevenLabs token mint failed: {exc}"})


# ---------------------------------------------------------------------------
# Loopback-only opener (no proxy, no redirects)
# ---------------------------------------------------------------------------

from urllib.request import ProxyHandler, build_opener, HTTPRedirectHandler

class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise URLError("Redirects not allowed for loopback sidecar")


def _build_loopback_opener():
    return build_opener(ProxyHandler({}), _NoRedirectHandler())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Voice sidecar for Hermes WebUI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7789)
    args = parser.parse_args()

    server = HTTPServer((args.host, args.port), _SidecarHandler)
    print(f"voice-sidecar listening on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nvoice-sidecar shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
