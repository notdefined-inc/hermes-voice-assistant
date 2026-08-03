# Voice Assistant — Hermes WebUI Extension

Always-on voice mode for [Hermes WebUI](https://hermes-agent.nousresearch.com): a floating 🎤 orb that lets you talk to the agent and hear it reply, Jarvis-style.

Silero neural VAD (speech detection) · local faster-whisper transcription · Edge TTS voice replies · gapless pipelined audio · configurable crisp/truncate speech modes.

![Voice Assistant preview](assets/voice-assistant.css)

## Features

- **Always-on voice loop** — click the 🎤 orb, speak, and the agent replies aloud, then re-arms for the next turn
- **Neural speech detection** — [Silero VAD](https://github.com/ricky0123/vad-web) (WASM/ONNX) in the browser; no fragile RMS thresholds
- **Local STT** — uses the WebUI's `/api/transcribe` (faster-whisper, runs locally, free, no API key)
- **Free TTS** — `/api/tts` with Edge TTS; pick voice (default `en-GB-SoniaNeural`, UK)
- **Gapless playback** — double-buffered chunk prefetch eliminates the "pause at every comma" network gap
- **Two speech modes (independent settings):**
  - **Crisp Replies** — prompts the agent itself to answer short and direct (several sentences max)
  - **Truncate Speech** — caps read-aloud length at an adjustable budget; full answer stays on screen
- **SSE-based response detection** — intercepts the `done` event; no fragile DOM scraping
- **Feedback-proof** — mic paused during TTS; no speaker→mic echo loop
- **Toggle-off anywhere** — single click (or Esc) in any state stops listening/recording/speaking
- **Settings panel** — double-click the orb: TTS on/off, auto-listen, sensitivity, voice, crisp, truncate budget

## How it works

```
Click 🎤 → getUserMedia (secure context) → pass stream into Silero VAD
VAD detects speech start → record
VAD detects silence → audio → POST /api/transcribe → text
text → #msg → global send()
agent replies → SSE 'done' event intercepted → extract final text
→ crispify (optional truncate) → POST /api/tts (prefetched, gapless) → play
→ cooldown → VAD re-arms → back to listening
```

## Installation

### 1. Copy the extension files

```bash
mkdir -p ~/.hermes/webui/extensions/voice-assistant
cp -r assets/ manifest.json extension.json ~/.hermes/webui/extensions/voice-assistant/
```

### 2. Register in the install manifest

Add to `~/.hermes/webui/extension-install-manifest.json` under `"installed"`:

```json
"voice-assistant": {
  "version": "3.3.0",
  "files": [
    "assets/voice-assistant.js",
    "assets/voice-assistant.css",
    "extension.json",
    "manifest.json"
  ],
  "installed_at": "<ISO timestamp>"
}
```

### 3. Server-side prerequisites (REQUIRED for this extension)

Three one-time server changes are needed for the voice stack to work:

#### a. CSP must allow WebAssembly for Silero VAD

The WebUI CSP is hardcoded in `~/hermes-webui/api/helpers.py` (~line 76), no env override. Add `'wasm-unsafe-eval'` to `script-src`:

```python
"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://static.cloudflareinsights.com blob:; "
```

Then restart: `systemctl --user restart hermes-webui` and verify **both** CSP headers contain it:

```bash
curl -s -I http://localhost:8787/ | grep -i content-security-policy
```

(`'wasm-unsafe-eval'` is narrow and safe — it only allows WASM **compilation**, not arbitrary JS `eval()`. Do **not** use `'unsafe-eval'`.)

#### b. Enable the UK / desired TTS voices in the server allowlist

`POST /api/tts` validates `voice` against a hardcoded allowlist in `~/hermes-webui/api/routes.py` (~line 18321). The shipped set has **no UK voices** — `en-GB-SoniaNeural` returns `400 {"error":"invalid voice"}`. Add the voices you want:

```python
allowed = {
    ...,
    "en-GB-SoniaNeural", "en-GB-RyanNeural", "en-GB-LibbyNeural",
    "en-GB-ThomasNeural", "en-US-JennyNeural",
}
```

Then restart the WebUI. The voice picker in the settings panel must stay in sync with this allowlist.

#### c. Use a secure context

`navigator.mediaDevices` only exists on localhost or HTTPS. Connect via `http://localhost:8787` or an HTTPS URL (Tailscale Funnel / real domain). Plain HTTP over a Tailnet IP hides the mic API — the orb will show "Mic needs localhost or HTTPS connection".

### 4. Prerequisites already in the WebUI

The transcription and TTS endpoints ship with the WebUI — no extra server work:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/transcribe` | faster-whisper STT (local, free) |
| `GET /api/transcribe/capability` | STT availability check |
| `POST /api/tts` | Edge TTS (free, 5000-char cap, ~2s client rate limit) |

### 5. Reload

Reload the WebUI page. The 🎤 orb appears bottom-right. No build step, no dependencies to install.

## Usage

| Action | Result |
|--------|--------|
| **Click 🎤** | Start listening → speak → agent replies aloud → re-arms |
| **Click 🎤 (any state)** | Stop: cancels recording / TTS / processing, returns to idle |
| **Double-click 🎤** | Open settings panel |
| **Ctrl+Shift+V** | Toggle voice session |
| **Esc** | Full stop from any active state |

### Settings (double-click the orb)

- **TTS Responses** — speak replies aloud
- **Auto-Listen** — re-arm mic after the reply finishes
- **Sensitivity** — slider (left = less sensitive, right = more)
- **TTS Voice** — pick an allowed server voice
- **Crisp Replies** — append a prompt directive so the agent answers short & direct
- **Truncate Speech** + **Max chars** — cap read-aloud length at a sentence boundary ("The full answer is on screen.")

## Files

```
voice-assistant/
├── manifest.json          # server asset discovery (REQUIRED — this is what loads scripts)
├── extension.json         # metadata + gallery info
├── assets/
│   ├── voice-assistant.js # main extension (= SKILL.md v2+ canonical code)
│   └── voice-assistant.css# orb, status bar, settings panel styling
└── skill/
    └── SKILL.md           # architecture + hard-won pitfalls (from hermes-webui-extension-development skill)
```

## Requirements

- Hermes WebUI (`nesquena/hermes-webui`)
- Works over HTTPS or localhost (mic requires a secure context)
- Server: `'wasm-unsafe-eval'` CSP (see above) + desired Edge voices in the `/api/tts` allowlist
- Browser: modern Chrome/Edge/Safari/Firefox (WebRTC, WASM, `EventSource`)

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `Speech detection init failed` / WASM toast | CSP missing `'wasm-unsafe-eval'` — patch `helpers.py`, restart, verify header with curl |
| `Cannot read properties of undefined (reading 'getUserMedia')` | `navigator.mediaDevices` absent (non-secure context). Connect via localhost/HTTPS |
| Speaking "not working", everything else fine | `/api/tts` voice not in the server allowlist → `400 invalid voice`. Add UK voices, restart |
| Pauses at every comma | Fixed by pipelined prefetch (v3.2+). Ensure you're running the latest `voice-assistant.js` |
| Orb stuck while "Thinking…" | SSE `done` event missed; watchdog auto-recovers to idle after 3 min |
| Mic picks up slight sounds | Raise Sensitivity (moves to "less sensitive"), or set higher `positiveSpeechThreshold` |

## Credits

- [@ricky0123/vad-web](https://github.com/ricky0123/vad-web) — Silero VAD, WASM/ONNX in-browser
- Faster-whisper, Edge TTS — served via the Hermes WebUI's built-in endpoints
- Built for [Hermes Agent](https://hermes-agent.nousresearch.com)

## License

MIT
