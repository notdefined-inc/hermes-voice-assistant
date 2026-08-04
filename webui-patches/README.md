# WebUI Source Patches

These patches are applied on top of the upstream `nesquena/hermes-webui` repository
after pulling. They add support needed by the voice-assistant extension that can't
be done through the extension system alone.

## Current Patch: `webui-voice-sidecar.patch`

**Last updated:** 2026-08-04  
**Applies on top of:** `5dd8b5da` (our earlier commit: CSP + STT provider + voice allowlist)

### What this patch does

1. **Sidecar proxy timeout: 10s → 120s** (`routes.py:5562`) — Supertonic TTS on a 2-vCPU VPS takes 5-8s per sentence; under streaming prefetch load some requests exceed 10s.
2. **Sidecar proxy response cap: 512KB → 2MB** (`routes.py:278`) — Supertonic WAV chunks can be 400KB+; the 512KB cap would truncate longer sentences.
3. **Removed Supertonic TTS handler** (`routes.py`) — ~80 lines. Now handled by the voice-sidecar service at `:7789`.
4. **Removed ElevenLabs token endpoint** (`routes.py`) — ~100 lines. Now handled by the voice-sidecar service at `:7789`.
5. **Fixed STT provider override** (`upload.py`) — Hermes' `transcribe_audio()` accepts `model=`, not `provider=`. Maps provider names to model names.

### How to apply after pulling upstream

```bash
cd ~/hermes-webui

# Pull upstream changes
git pull origin master

# Apply our patches
git apply ~/workspace/hermes-voice-assistant/webui-patches/webui-voice-sidecar.patch

# If there are conflicts, apply with --3way and resolve manually
git apply --3way ~/workspace/hermes-voice-assistant/webui-patches/webui-voice-sidecar.patch

# Restart WebUI
systemctl --user restart hermes-webui
```

### Remaining patches in commit `5dd8b5da` (already committed)

These are in the git history and survive pulls:

- **CSP `wasm-unsafe-eval`** (`helpers.py`) — allows Silero VAD WASM compilation
- **UK Edge voices** (`routes.py`) — `en-GB-SoniaNeural` etc. in the allowlist
- **ElevenLabs/OpenAI voice override** (`routes.py`) — per-request voice ID pass-through
- **STT provider field** (`upload.py`) — initial `provider` form field parsing

### Services required

```bash
# Voice sidecar (Supertonic proxy + ElevenLabs token mint)
systemctl --user status voice-sidecar    # :7789

# Supertonic TTS server
systemctl --user status supertonic-tts   # :7788
```
