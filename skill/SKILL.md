---
name: hermes-voice-assistant
description: "Operating and troubleshooting the Voice Assistant WebUI extension for Hermes: Silero VAD, SSE-based response detection, Edge TTS, crisp/truncate speech modes, and the server-side prerequisites (CSP wasm-unsafe-eval, TTS voice allowlist)."
version: 3.3.0
author: Twilla
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes, webui, extension, voice, vad, tts, silero, sse]
    related_skills: [hermes-webui-extension-development]
    created_by: agent
---

# Voice Assistant — Hermes WebUI Extension

Operations guide for the `voice-assistant` extension (floating 🎤 orb, Jarvis-style
continuous voice loop). Reference impl: `~/.hermes/webui/extensions/voice-assistant/`.

## The working pipeline (do not regress)

```
Click orb → getUserMedia (procure the stream YOURSELF, guarded) → pass stream into Silero VAD
VAD.onSpeechStart → MediaRecorder.start
VAD.onSpeechEnd → blob → POST /api/transcribe → text
text → inject into #msg → call global send()
agent responds → SSE 'done' event intercepted → extract final text
→ crispify (optional truncate) → POST /api/tts (prefetched, gapless) → play
→ VAD paused during playback (no feedback) → cooldown (~500ms) → VAD.start → listening
```

## Server endpoints (no server changes needed — shipped with WebUI)

| Endpoint | Request | Returns |
|----------|---------|---------|
| `POST /api/transcribe` | multipart form, field `file` | `{"ok":true,"transcript":"..."}` — faster-whisper, local, free |
| `GET /api/transcribe/capability` | — | `{"available":bool,"provider":"..."}` |
| `POST /api/tts` | JSON `{text, engine:"edge", voice, rate}` | audio blob (Edge TTS, free; 5000-char cap, ~2s rate limit per client) |

## Server-side prerequisites (REQUIRED — three things)

### 1. CSP: `'wasm-unsafe-eval'` for Silero VAD (NOT `'unsafe-eval'`)

Silero VAD (`@ricky0123/vad-web`) runs ONNX Runtime in WASM, which needs
`'wasm-unsafe-eval'` in `script-src`. The WebUI CSP is hardcoded in
`~/hermes-webui/api/helpers.py` (~line 76) — no env override exists for
script-src. Patch it, then restart the WebUI service
(`systemctl --user restart hermes-webui`). Verify BOTH surfaced headers carry
it after restart: `curl -s -I http://localhost:8787/ | grep -i
content-security-policy`. The enforced `Content-Security-Policy` header is what
matters; the `-Report-Only` variant alone is just a warning channel.
`cdn.jsdelivr.net` is already allowed in `script-src` + `connect-src`, so the
module + ONNX model + wasm load fine.

### 2. `/api/tts` voice allowlist

The `edge` engine validates `voice` against a hardcoded `allowed` set in
`~/hermes-webui/api/routes.py` (~line 18321). Unlisted voices return **HTTP 400
`{"error":"invalid voice"}`** and the orb silently never speaks. The shipped set
had no UK voices. Add e.g. `en-GB-SoniaNeural`, `en-GB-RyanNeural`,
`en-GB-LibbyNeural`, `en-GB-ThomasNeural`, `en-US-JennyNeural`, then restart the
WebUI. Diagnose: `curl -b <cookie> -X POST http://localhost:8787/api/tts -H
'Content-Type: application/json' -d '{"text":"hi","engine":"edge","voice":"en-GB-SoniaNeural"}'`
→ `400 invalid voice` = allowlist, not a code typo.

### 3. Secure context (mic access)

`navigator.mediaDevices` only exists on localhost or HTTPS. Plain HTTP over a
Tailnet IP (e.g. `http://100.105.61.119:8787`) → `navigator.mediaDevices` is
`undefined` → Silero's INTERNAL `getUserMedia()` call throws
`Cannot read properties of undefined (reading 'getUserMedia')`. Fix: procure
the MediaStream yourself (guarded, with friendly toasts) then pass
`stream: <yourStream>` into `MicVAD.new()` — with a stream supplied the library
never touches `mediaDevices`. Tell users to connect via `localhost:8787` or HTTPS.

## Response completion: SSE 'done' event (the ONLY reliable way)

The WebUI streams via `EventSource('api/chat/stream?...')` and fires a `done`
SSE event whose `data.session.messages[]` holds the final transcript. Intercept
by monkey-patching global EventSource:

```js
var OrigES = window.EventSource;
window.EventSource = function (url, config) {
  var es = new OrigES(url, config);
  es.addEventListener('done', function (e) {
    var d = JSON.parse(e.data);
    var msgs = (d.session && d.session.messages) || [];
    for (var i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].role === 'assistant') { /* text = msgs[i].content; trigger TTS */ break; }
  });
  return es;
};
window.EventSource.prototype = OrigES.prototype;
```

DOM-scraping fails (previous-message fires immediately; stability counters fire
mid-stream; CSS classes version-drift). Always add a watchdog (~2-3 min) so a
missed `done` can never strand the orb.

## Acoustic feedback — mute the mic, don't filter the echo

The mic hears TTS through the speakers → VAD self-fires → stuck loop. Adaptive
RMS baselines and `echoCancellation: true` are unreliable. **The reliable fix:
no mic input during playback** — `vad.pause()` before the first chunk,
`vad.start()` after a ~500ms post-playback cooldown. Click the orb to interrupt
TTS (no voice barge-in — accepted trade).

## Orb interaction — toggle, not double-fire

Delay the single-click action ~300ms; a second click within the window opens
settings and cancels the pending single action. Single click in ANY active mode
(listening/speaking/transcribing/processing) = `stopEverything()` (pause VAD,
kill recorder, stop TTS, set idle). Esc = same full stop.

## Crisp vs Truncate (v3.3 — two ORTHOGONAL settings)

1. **Crisp Replies** (`crispPrompt`) — prompt-level: appends a directive to the
   outgoing message so the AGENT answers short/direct. The on-screen answer is
   short too.
2. **Truncate Speech** (`truncateEnabled` + `truncateChars`) — speech-layer:
   caps read-aloud length with an adjustable budget (default 450, min 60 max
   4000). `crispify()` cuts at a sentence boundary + appends "The full answer
   is on screen." When disabled it still returns CLEANED prose (strips
   markdown/emoji/whitespace — never let `**bold**` or backticks reach TTS).

Caveat: truncation is a prefix strategy, not a true summary — the agent's real
point may sit later in the reply. Offer to raise budget / switch to an LLM
one-liner if it cuts off before the answer.

## Sentence splitting — decimals & double-periods

- `2.1GB` garbles to "2 point 1 GB" with a naive period split. Use
  `text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/g)` with a regex fallback.
- Markdown bold + `\n\n` produces `..` → chain
  `text.replace(/\.\s+\.\s+/g, '. ')` then `text.replace(/\.{2,}/g, '.')`.

## TTS playback gaps — pipelined prefetch

"Pauses at every comma" = network round-trip per chunk, not prosody. Fix:
double-buffer — `var nextFetch = fetchAudioBlob(chunks[0]);` then inside the
loop `var url = await nextFetch; nextFetch = /* fetch next */; await
playAudioURL(url)`. Raise chunk size (~280 → ~500 chars).

## stopTTS vs VAD ownership

`stopTTS()` should ONLY cut `<audio>` playback. VAD resume is owned by
`nextListen()` / `stopEverything()` — if `stopTTS()` also calls `vad.start()`
it fights full-stop call sites.

## Resource impact (2 vCPU / 3.7 GB VPS)

- faster-whisper STT: ~1-3s per utterance, model stays loaded
- Edge TTS: network ~1-2s, minimal CPU, 2s client rate limit
- Continuous/wake-word chunked transcription: heavy server CPU — avoid on <4 GB
  RAM boxes; click-to-talk is the default.

## Files

```
voice-assistant/
├── manifest.json          # server asset discovery (REQUIRED — loads scripts)
├── extension.json         # metadata
├── assets/
│   ├── voice-assistant.js # main extension (canonical code)
│   └── voice-assistant.css
└── skill/SKILL.md         # this guide
```
