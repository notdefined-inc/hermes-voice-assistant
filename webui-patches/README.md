# WebUI Source Patches

These patches are applied on top of the upstream `nesquena/hermes-webui` repository
after pulling. They add support needed by the voice-assistant extension that can't
be done through the extension system alone.

## Current Patch: `webui-minimal.patch` (REQUIRED)

**Last updated:** 2026-08-04  
**Applies on top of:** `320789ae` (upstream master, latest as of 2026-08-04)

### What this patch does — 34 added lines, 5 removed

1. **CSP `'wasm-unsafe-eval'`** (`api/helpers.py`) — allows Silero VAD WASM compilation.
2. **UK Edge voices** (`api/routes.py`) — `en-GB-SoniaNeural`, `en-GB-RyanNeural`, `en-GB-LibbyNeural`, `en-GB-ThomasNeural`, `en-US-JennyNeural` in the TTS allowlist.
3. **ElevenLabs voice override** (`api/routes.py`) — per-request `voice` field overrides config, so the extension can switch voice profiles per-session.
4. **Sidecar proxy timeout: 10s → 120s** (`api/routes.py`) — Supertonic TTS on a 2-vCPU VPS takes 5-8s per sentence; under streaming prefetch load some requests exceed 10s.
5. **Sidecar proxy response cap: 512KB → 2MB** (`api/routes.py`) — Supertonic WAV chunks can be 400KB+.
6. **STT provider override** (`api/upload.py`) — maps extension provider names (local/groq/openai/mistral/xai/deepinfra) to Hermes model names.

### How to apply after pulling upstream

```bash
cd ~/hermes-webui

# Pull upstream changes (discard any local commits — we only use patches now)
git fetch origin
git reset --hard origin/master

# Apply our minimal patch
git apply ~/workspace/hermes-voice-assistant/webui-patches/webui-minimal.patch

# If there are conflicts, apply with --3way and resolve manually
git apply --3way ~/workspace/hermes-voice-assistant/webui-patches/webui-minimal.patch

# Restart WebUI
systemctl --user restart hermes-webui
```

### Verify after apply

```bash
# CSP header carries wasm-unsafe-eval
curl -s -I http://127.0.0.1:8787/ | grep -i content-security-policy | head -1

# Sidecar proxy works
curl -s http://127.0.0.1:8787/api/extensions/voice-assistant/sidecar/health \
  -H "Origin: http://127.0.0.1:8787" -H "Sec-Fetch-Site: same-origin"

# Extension scripts injected
curl -s http://127.0.0.1:8787/ | grep -c 'src="/extensions/voice-assistant/'
```

## Historical Patches (for reference only)

- **`0001-webui-voice-patch-5dd8b5da.patch`** — our old commit `5dd8b5da` (CSP + STT provider + voice allowlist + Supertonic handler + ElevenLabs token endpoint). **DO NOT apply** — it was replaced by the sidecar refactor and the minimal patch.
- **`webui-voice-sidecar.patch`** — transitional patch (sidecar refactor on top of old commit). **DO NOT apply** — superseded by `webui-minimal.patch`.

## Workflow Policy (going forward)

- **NO direct commits to `~/hermes-webui`.** The repo stays pristine upstream; all our changes live in `webui-minimal.patch`.
- After every `git pull`/`git reset --hard origin/master`, re-apply the patch.
- If upstream adopts any of our changes (CSP, voices, etc.), remove them from the patch — smaller is better.

## Services required

```bash
# Voice sidecar (Supertonic proxy + ElevenLabs token mint)
systemctl --user status voice-sidecar    # :7789

# Supertonic TTS server
systemctl --user status supertonic-tts   # :7788
```
