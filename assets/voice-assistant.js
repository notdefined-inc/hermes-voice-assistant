/**
 * Voice Assistant Extension v4.3.3 for Hermes WebUI
 *
 * Battle-tested stack:
 *  - Silero VAD (@ricky0123/vad-web v0.0.24) from CDN — neural network voice
 *    activity detection, no fragile RMS thresholds. Requires 'wasm-unsafe-eval'
 *    in CSP (added to api/helpers.py).
 *  - EventSource monkey-patch — intercepts SSE 'done' event for definitive
 *    response completion. No DOM scraping.
 *  - Mic fetch/mute during TTS playback — audio only captured via MediaRecorder
 *    tied to the active stream; VAD paused during speech output to prevent
 *    self-triggering feedback.
 *
 * v4.3.3: FIX "final response miss sometimes". (1) Non-speakable sentences
 * (e.g. a lone emoji "😄") are now skipped before TTS — they were POSTed to
 * Supertonic with an effectively-empty body, got HTTP 400, and the uncaught
 * error killed the tail sentence so text showed on screen but was never spoken.
 * (2) A TTS prefetch that fails (429/400) no longer silently drops that chunk;
 * the whole sentence falls back to speakText which re-fetches every chunk.
 *
 * v4.3.3: FIX live-STT results being thrown away. finish() timed out after
 * 3000ms while WhisperLiveKit on the VPS needs 6-30s to agree on final text
 * (ready_to_stop). The 3s timeout resolved with empty → wasted the good 161-char
 * transcript that arrived moments later at ready_to_stop → fell to the 21s
 * batch transcribe → garbled/short text went to the agent. finish() now waits
 * up to 20000ms for ready_to_stop (per-session override finishTimeoutMs).
 *
 * v4.3.3: FIX live-STT failure after the first utterance. Each utterance now
 * gets its own WhisperLiveKit session (one WS + one ready_to_stop per utterance)
 * instead of a single shared session whose start() force-closed the previous
 * utterance's pending finish. This was causing "Live STT EMPTY → batch fallback"
 * (8-11s) whenever the user spoke again before WLK finalized — the "words get
 * cut / not smooth" symptom.
 *
 * v4.3.0: Every pipeline stage now logs with a wall-clock + elapsed-since-boot
 * timestamp and a [TAG] group. Tags: BOOT VAD STT SSE SEND TURN STEER TTS AUDIO
 * RESP CTRL + WLK-* from the live STT WebSocket client. Look for SSE-TIMING /
 * TTS-TIMING / STT-WARN / STEER-WARN to find where latency or fallbacks occur.
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  //  Timestamped debug logging — every pipeline stage logs wall-clock
  //  time + ms-since-boot so delays/stalls are visible in the console.
  //  Format: [VA 12:34:56.789 +4567ms] [TAG] message
  // ═══════════════════════════════════════════════════════════════

  var VA_BOOT = Date.now();
  function vaTs() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + ('00' + d.getMilliseconds()).slice(-3);
  }
  function vaDbg(tag, msg) {
    console.log('[VA ' + vaTs() + ' +' + (Date.now() - VA_BOOT) + 'ms] [' + tag + '] ' + msg);
  }
  // Expose for sibling pipeline scripts (live-stt-client, turn coordinator)
  // so the whole pipeline shares one timestamped log source.
  window.vaDbg = vaDbg;
  window.vaTs = vaTs;

  // ═══════════════════════════════════════════════════════════════
  //  Config & State
  // ═══════════════════════════════════════════════════════════════

  var CFG = {
    // Silero VAD — conservative defaults: only trigger on confident speech,
    // ignore faint ambient sounds / whispers.
    positiveSpeechThreshold: 0.80,
    negativeSpeechThreshold: 0.65,
    minSpeechFrames: 5,
    preSpeechPadFrames: 1,
    redemptionFrames: 6,

    autoListen: true,
    autoListenDelay: 500,

    // WhisperLiveKit supplies provisional text while speech is still arriving.
    // Silero's complete utterance still goes through /api/transcribe for the
    // authoritative final text, avoiding unstable end-of-stream hypotheses.
    streamingSttEnabled: true,
    streamingSttHost: 'notdefined.tail8da646.ts.net',
    streamingSttPort: 7790,
    streamingSttSecure: true,
    streamingSttLanguage: 'auto',

    ttsEnabled: true,
    ttsEngine: 'edge',       // edge | openai | elevenlabs | browser | supertonic-server | supertonic
    ttsRate: '',
    ttsChunkSize: 500,
    // Per-engine voice profiles. ttsVoice is the Edge name (allowlisted by the
    // server); elevenlabsVoice is the ElevenLabs voice_id; openaiVoice is the
    // OpenAI voice name. Supertonic has its own voice/language/quality controls.
    // NOTE: ElevenLabs default = Adam (pNInz6obpgDQGcFmaJgB), a FREE creator
    // voice. Library voices (e.g. m3yAHyFEFKtbCIM5n7GF) require a paid plan.
    ttsVoice: 'en-GB-SoniaNeural',
    elevenlabsVoice: 'pNInz6obpgDQGcFmaJgB',
    openaiVoice: 'alloy',
    supertonicVoice: 'F1',
    supertonicLang: 'na',
    supertonicSteps: 5,
    supertonicSpeed: 1.05,
    supertonicServerMigrationDone: false,

    // Speech detection (Silero VAD) — configurable timing. All in milliseconds.
    // preRollMs = audio buffered before speech is confirmed (fixes cut-off starts)
    // minSpeechMs = how long speech must persist before being accepted (misfire guard)
    // endSilenceMs = trailing silence that ends the utterance
    preRollMs: 500,
    minSpeechMs: 300,
    endSilenceMs: 1200,

    // Crisp Replies: append a directive to the outgoing message so the AGENT
    // itself answers short and direct. The full answer reflects this — it's
    // a prompt-level change, not a speech-layer cap.
    crispPrompt: false,
    crispDirective: "Keep your answer short, direct and conversational — a few sentences max. If there's more detail, give a brief summary and mention the details are on screen.",

    // Truncate: speech-layer cap on spoken length. The full text stays on
    // screen for reading; only the read-aloud portion is capped.
    truncateEnabled: false,
    truncateChars: 450,
  };

  var STATE = {
    vad: null,
    audioStream: null,
    mediaRecorder: null,
    chunks: [],
    phase: 'idle',           // idle | listening | transcribing | processing | speaking
    forcedRecording: false,
    ttsAudio: null,
    // Mobile Safari/Chrome only allow media playback after an explicit user
    // gesture. Keep one Audio element and unlock it from the orb/page tap;
    // creating a fresh Audio after an async TTS fetch loses that activation.
    playbackAudio: null,
    audioUnlocked: false,
    speechUnlocked: false,
    // Number of VAD speech-start callbacks not yet paired with speech-end or
    // misfire. Each start immediately holds response finalization, including
    // the time while the user is still talking.
    openSpeechCaptures: 0,
    stopGeneration: 0,
    ttsActive: false,
    responseDone: false,
    responseText: '',
    // True once the voice loop has launched a request (start or steer) and is
    // awaiting the agent's reply. The SSE 'done' handler speaks whenever this
    // is set, regardless of the current phase — so steered follow-ups queued
    // into the same turn still get read aloud (fixes "only first reply spoken").
    expectingReply: false,
    evalWasmTested: false,
    panelOpen: false,
    sseHooked: false,
    liveStt: null,
    liveSttContext: null,
    liveSttSource: null,
    liveSttProcessor: null,
    liveSttGain: null,
    liveSttEncoder: null,
    liveTranscript: '',
    liveSttErrorShown: false,
    // Pipeline timing markers (wall-clock ms) for debugging where time goes.
    sentAt: 0,
    firstTokenAt: 0,
    lastSpeechEndAt: 0,
  };

  var TURN = new window.VoiceTurnCoordinator({
    settleMs: 750,
    onFinal: function (text) {
      vaDbg('TURN', 'onFinal fired: text=' + (text ? text.slice(0, 80) + '…' : '(empty)') + ' expectingReply=' + STATE.expectingReply);
      STATE.responseDone = true;
      STATE.responseText = text;
      if (STATE.expectingReply) finalizeStreamingResponse(text);
    },
  });
  var PLAYBACK = new window.InterruptiblePlayback();
  var STT_QUEUE = new window.SerialVoiceTaskQueue();
  var STREAM_TEXT = new window.IncrementalVoiceSentenceBuffer();
  var STREAM_SPEECH = {
    streamId: '',
    sawTokens: false,
    deferred: [],
    chain: Promise.resolve(),
    playbackToken: null,
    finalizing: false,
    streamCreatedAt: 0,
  };

  function activeStreamId() {
    if (typeof S === 'undefined') return '';
    return String(S.activeStreamId || (S.session && S.session.active_stream_id) || '');
  }

  function streamIdFromUrl(url) {
    try {
      return new URL(String(url || ''), document.baseURI).searchParams.get('stream_id') || '';
    } catch (_) { return ''; }
  }

  var LS_KEY = 'va-settings-v3';

  // Tiny valid PCM WAV containing silence. Playing it during the user's tap
  // grants the persistent Audio element permission for later async replies.
  var SILENT_WAV = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQgAAAAAAAAAAAA=';

  function ensurePlaybackAudio() {
    if (STATE.playbackAudio) return STATE.playbackAudio;
    var audio = document.createElement('audio');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.preload = 'auto';
    STATE.playbackAudio = audio;
    return audio;
  }

  function unlockMobileAudio() {
    var audio = ensurePlaybackAudio();
    if (!STATE.audioUnlocked) {
      try {
        // The file itself is silent. Keep the element unmuted: Safari may allow
        // muted autoplay without granting later audible playback permission.
        audio.muted = false;
        audio.volume = 1;
        audio.src = SILENT_WAV;
        var p = audio.play();
        if (p && typeof p.then === 'function') {
          p.then(function () {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
            STATE.audioUnlocked = true;
            console.log('[VA] Mobile audio playback unlocked');
          }).catch(function (err) {
            audio.muted = false;
            console.warn('[VA] Mobile audio unlock deferred:', err);
          });
        } else {
          audio.muted = false;
          STATE.audioUnlocked = true;
        }
      } catch (err) {
        audio.muted = false;
        console.warn('[VA] Mobile audio unlock failed:', err);
      }
    }

    // Web Speech has a separate autoplay gate on iOS. Prime it from the same
    // gesture, silently; later Browser-engine utterances can then start.
    if (!STATE.speechUnlocked && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
      try {
        window.speechSynthesis.resume();
        var prime = new SpeechSynthesisUtterance(' ');
        prime.volume = 0;
        window.speechSynthesis.speak(prime);
        STATE.speechUnlocked = true;
      } catch (err2) {
        console.warn('[VA] Browser speech unlock deferred:', err2);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Persistence
  // ═══════════════════════════════════════════════════════════════

  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        positiveSpeechThreshold: CFG.positiveSpeechThreshold,
        negativeSpeechThreshold: CFG.negativeSpeechThreshold,
        autoListen: CFG.autoListen,
        ttsEnabled: CFG.ttsEnabled,
        ttsVoice: CFG.ttsVoice,
        ttsEngine: CFG.ttsEngine,
        elevenlabsVoice: CFG.elevenlabsVoice,
        openaiVoice: CFG.openaiVoice,
        supertonicVoice: CFG.supertonicVoice,
        supertonicLang: CFG.supertonicLang,
        supertonicSteps: CFG.supertonicSteps,
        supertonicSpeed: CFG.supertonicSpeed,
        supertonicServerMigrationDone: CFG.supertonicServerMigrationDone,
        ttsRate: CFG.ttsRate,
        preRollMs: CFG.preRollMs,
        minSpeechMs: CFG.minSpeechMs,
        endSilenceMs: CFG.endSilenceMs,
        crispPrompt: CFG.crispPrompt,
        truncateEnabled: CFG.truncateEnabled,
        truncateChars: CFG.truncateChars,
      }));
    } catch (_) {}
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      for (var k in s) { if (CFG.hasOwnProperty(k)) CFG[k] = s[k]; }

      // v3.8 capture tuning: increase phrase-boundary padding only when the
      // values are still the former stock defaults. Preserve user adjustments.
      if (typeof window.migrateVoiceCaptureSettings === 'function') {
        var tuned = window.migrateVoiceCaptureSettings({
          preRollMs: CFG.preRollMs,
          minSpeechMs: CFG.minSpeechMs,
          endSilenceMs: CFG.endSilenceMs,
        });
        CFG.preRollMs = tuned.preRollMs;
        CFG.minSpeechMs = tuned.minSpeechMs;
        CFG.endSilenceMs = tuned.endSilenceMs;
      }

      // Migrate v3.1 "speechBudgetChars" → v3.3 truncate {
      if (typeof s.speechBudgetChars === 'number' && s.speechBudgetChars > 0) {
        CFG.truncateEnabled = true;
        CFG.truncateChars = s.speechBudgetChars;
      }
      // } end migration

      // v3.5: ElevenLabs default voice was a PAID library voice that returns
      // 402 on free accounts. Replace any broken (paid-only) library voice_id
      // with the free Adam creator voice so ElevenLabs works out of the box.
      var BROKEN_EL_VOICES = { 'm3yAHyFEFKtbCIM5n7GF': true };  // known paid library voice
      if (CFG.elevenlabsVoice && BROKEN_EL_VOICES[CFG.elevenlabsVoice]) {
        CFG.elevenlabsVoice = 'pNInz6obpgDQGcFmaJgB';  // Adam (free)
        saveSettings();
      }

      // v3.7: server-side is now the practical default. Preserve the browser
      // engine as an explicit opt-in after this one-time migration.
      if (!CFG.supertonicServerMigrationDone) {
        if (CFG.ttsEngine === 'supertonic') CFG.ttsEngine = 'supertonic-server';
        CFG.supertonicServerMigrationDone = true;
        saveSettings();
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════
  //  DOM
  // ═══════════════════════════════════════════════════════════════

  var orb, levelBar, levelFill, statusLabel, panel;

  function injectUI() {
    orb = document.createElement('button');
    orb.id = 'va-orb';
    orb.title = 'Voice Assistant (Ctrl+Shift+V)';
    orb.innerHTML = '🎤';
    orb.addEventListener('click', onOrbClick);
    document.body.appendChild(orb);

    levelBar = document.createElement('div');
    levelBar.id = 'va-level-bar';
    levelFill = document.createElement('div');
    levelFill.id = 'va-level-fill';
    levelBar.appendChild(levelFill);
    document.body.appendChild(levelBar);

    statusLabel = document.createElement('div');
    statusLabel.id = 'va-status-label';
    statusLabel.textContent = 'Listening…';
    document.body.appendChild(statusLabel);

    var rippleC = document.createElement('div');
    rippleC.id = 'va-ripple-container';
    document.body.appendChild(rippleC);

    panel = document.createElement('div');
    panel.id = 'va-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);
    wirePanel();

    document.addEventListener('click', function (e) {
      if (STATE.panelOpen && panel && !panel.contains(e.target) && orb !== e.target) closePanel();
    });
  }

  function buildPanelHTML() {
    var sensVal = Math.round((0.86 - CFG.positiveSpeechThreshold) / 0.06) + 1;  // 0.86→1 least sensitive, 0.32→10 most
    if (sensVal < 1) sensVal = 1;
    if (sensVal > 10) sensVal = 10;
    return [
      '<h3>🎙️ Voice Assistant</h3>',
      '<div class="va-setting-row"><div><label>TTS Responses</label><div class="va-hint">Speak agent replies aloud</div></div>',
      '<div class="va-toggle' + (CFG.ttsEnabled ? ' va-on' : '') + '" id="va-tts-toggle"><div class="va-toggle-knob"></div></div></div>',
      '<div class="va-setting-row"><div><label>Auto-Listen</label><div class="va-hint">Re-arm after response</div></div>',
      '<div class="va-toggle' + (CFG.autoListen ? ' va-on' : '') + '" id="va-auto-toggle"><div class="va-toggle-knob"></div></div></div>',
      '<div class="va-setting-row"><div><label>Live transcription</label><div class="va-hint">Show partial words while speaking</div></div>',
      '<div class="va-toggle' + (CFG.streamingSttEnabled ? ' va-on' : '') + '" id="va-live-stt-toggle"><div class="va-toggle-knob"></div></div></div>',
      '<div class="va-setting-row"><div><label>Sensitivity</label><div class="va-hint">← Less sensitive · More →</div></div>',
      '<div class="va-slider-row"><input type="range" min="1" max="10" value="' + sensVal + '" id="va-sens-slider">',
      '<span class="va-slider-val" id="va-sens-val">' + sensVal + '</span></div></div>',
      '<div class="va-setting-row"><div><label>TTS Engine</label><div class="va-hint" id="va-engine-hint">Edge = free, no key</div></div>',
      '<select id="va-engine-select">',
        '<option value="edge"' + (CFG.ttsEngine === 'edge' ? ' selected' : '') + '>Edge (free)</option>',
        '<option value="openai"' + (CFG.ttsEngine === 'openai' ? ' selected' : '') + '>OpenAI</option>',
        '<option value="elevenlabs"' + (CFG.ttsEngine === 'elevenlabs' ? ' selected' : '') + '>ElevenLabs</option>',
        '<option value="browser"' + (CFG.ttsEngine === 'browser' ? ' selected' : '') + '>Browser (client)</option>',
        '<option value="supertonic-server"' + (CFG.ttsEngine === 'supertonic-server' ? ' selected' : '') + '>Supertonic 3 (server · recommended)</option>',
        '<option value="supertonic"' + (CFG.ttsEngine === 'supertonic' ? ' selected' : '') + '>Supertonic 3 (browser · 400 MB)</option>',
      '</select></div>',
      '<div class="va-setting-row"><div><label>Voice</label><div class="va-hint" id="va-voice-hint">Choose a voice for the selected engine</div></div>',
      '<div id="va-voice-control">' + voiceControlHTML() + '</div></div>',
      '<div class="va-setting-row"><div><label>Playback check</label><div class="va-hint">Tap once on mobile to unlock and test audio</div></div>',
      '<button type="button" id="va-test-voice">Test voice</button></div>',
      '<div class="va-setting-row" id="va-supertonic-options" style="display:' + ((CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server') ? 'flex' : 'none') + '"><div><label>Language</label><div class="va-hint">Auto/mixed is best for Hinglish</div></div>',
      '<select id="va-supertonic-lang-select">',
        '<option value="na"' + (CFG.supertonicLang === 'na' ? ' selected' : '') + '>Auto / mixed (na)</option>',
        '<option value="en"' + (CFG.supertonicLang === 'en' ? ' selected' : '') + '>English</option>',
        '<option value="hi"' + (CFG.supertonicLang === 'hi' ? ' selected' : '') + '>Hindi</option>',
      '</select></div>',
      '<div class="va-setting-row" id="va-supertonic-quality" style="display:' + ((CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server') ? 'flex' : 'none') + '"><div><label>Quality</label><div class="va-hint">More steps sound better but take longer</div></div>',
      '<select id="va-supertonic-steps-select">',
        '<option value="5"' + (CFG.supertonicSteps === 5 ? ' selected' : '') + '>Fast (5)</option>',
        '<option value="8"' + (CFG.supertonicSteps === 8 ? ' selected' : '') + '>Balanced (8)</option>',
        '<option value="10"' + (CFG.supertonicSteps === 10 ? ' selected' : '') + '>High (10)</option>',
        '<option value="12"' + (CFG.supertonicSteps === 12 ? ' selected' : '') + '>Very high (12)</option>',
      '</select></div>',
      '<div class="va-setting-row" id="va-supertonic-speed" style="display:' + ((CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server') ? 'flex' : 'none') + '"><div><label>Speed</label><div class="va-hint">Recommended range: 0.9–1.5</div></div>',
      '<div class="va-slider-row"><input type="range" min="0.7" max="2" step="0.05" value="' + CFG.supertonicSpeed + '" id="va-supertonic-speed-slider">',
      '<span class="va-slider-val" id="va-supertonic-speed-val">' + Number(CFG.supertonicSpeed).toFixed(2) + '×</span></div></div>',
      '<div class="va-setting-row"><div><label>Start Pre-roll</label><div class="va-hint">Audio kept before speech is confirmed (fixes cut-off starts)</div></div>',
      '<div class="va-slider-row"><input type="range" min="0" max="900" step="50" value="' + CFG.preRollMs + '" id="va-preroll-slider">',
      '<span class="va-slider-val" id="va-preroll-val">' + CFG.preRollMs + 'ms</span></div></div>',
      '<div class="va-setting-row"><div><label>Min Speech</label><div class="va-hint">Longest sound before it counts as speech (kills misfires)</div></div>',
      '<div class="va-slider-row"><input type="range" min="100" max="1200" step="50" value="' + CFG.minSpeechMs + '" id="va-minspeech-slider">',
      '<span class="va-slider-val" id="va-minspeech-val">' + CFG.minSpeechMs + 'ms</span></div></div>',
      '<div class="va-setting-row"><div><label>End Silence</label><div class="va-hint">Trailing silence that ends the utterance</div></div>',
      '<div class="va-slider-row"><input type="range" min="200" max="2000" step="50" value="' + CFG.endSilenceMs + '" id="va-endsil-slider">',
      '<span class="va-slider-val" id="va-endsil-val">' + CFG.endSilenceMs + 'ms</span></div></div>',
      '<div class="va-setting-row"><div><label>Crisp Replies</label><div class="va-hint">Tell the agent to answer short & direct</div></div>',
      '<div class="va-toggle' + (CFG.crispPrompt ? ' va-on' : '') + '" id="va-crisp-toggle"><div class="va-toggle-knob"></div></div></div>',
      '<div class="va-setting-row"><div><label>Truncate Speech</label><div class="va-hint">Cap read-aloud length only</div></div>',
      '<div class="va-toggle' + (CFG.truncateEnabled ? ' va-on' : '') + '" id="va-truncate-toggle"><div class="va-toggle-knob"></div></div></div>',
      '<div class="va-setting-row" id="va-truncate-row" style="display:' + (CFG.truncateEnabled ? 'flex' : 'none') + '"><div><label>Max chars</label></div>',
      '<input type="number" id="va-truncate-input" min="60" max="4000" step="10" value="' + CFG.truncateChars + '" style="width:90px;"></div>',
      '<div style="font-size:11px;opacity:0.4;margin-top:12px;text-align:center;">v4.3.3 · Per-utterance live STT · Streaming TTS · Barge-in</div>',
    ].join('');
  }

  // Engine-aware voice control. Edge = allowlisted neural voices; OpenAI =
  // fixed voice names; ElevenLabs = voice_id (with known FREE voices as
  // presets — paid library voices return 402 on free accounts); Browser = OS
  // voices (lang tag or name).
  function voiceControlHTML() {
    if (CFG.ttsEngine === 'elevenlabs') {
      var FREE_EL = [
        ['pNInz6obpgDQGcFmaJgB', 'Adam'],
        ['EXAVITQu4vr4xnSDxMaL', 'Bella'],
        ['VR6AewLTigWG4xSOukaG', 'Arnold'],
        ['ErXwobaYiN019PkySvjV', 'Antoni'],
        ['onwK4e9ZLuTAKqWW03F9', 'Domi'],
      ];
      var opts = '<select id="va-voice-select">';
      var current = CFG.elevenlabsVoice || '';
      for (var i = 0; i < FREE_EL.length; i++) {
        opts += '<option value="' + FREE_EL[i][0] + '"' + (current === FREE_EL[i][0] ? ' selected' : '') + '>' + FREE_EL[i][1] + '</option>';
      }
      opts += '<option value="__custom__"' + (FREE_EL.every(function (f) { return f[0] !== current; }) ? ' selected' : '') + '>Custom…</option>';
      opts += '</select>';
      return opts;
    }
    if (CFG.ttsEngine === 'openai') {
      var oaiVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral', 'verse', 'ash', 'ballad', 'sage'];
      var opts2 = '<option value="">Default</option>';
      for (var j = 0; j < oaiVoices.length; j++) {
        opts2 += '<option value="' + oaiVoices[j] + '"' + (CFG.openaiVoice === oaiVoices[j] ? ' selected' : '') + '>' + oaiVoices[j] + '</option>';
      }
      return '<select id="va-voice-select">' + opts2 + '</select>';
    }
    if (CFG.ttsEngine === 'browser') {
      return '<input type="text" id="va-voice-input" value="' + (CFG.ttsVoice || '') + '" placeholder="e.g. en-GB, or voice name" style="width:180px;" spellcheck="false">';
    }
    if (CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server') {
      var supertonicVoices = [
        ['M1', 'Male 1'], ['M2', 'Male 2'], ['M3', 'Male 3'], ['M4', 'Male 4'], ['M5', 'Male 5'],
        ['F1', 'Female 1'], ['F2', 'Female 2'], ['F3', 'Female 3'], ['F4', 'Female 4'], ['F5', 'Female 5']
      ];
      var supertonicOptions = '<select id="va-voice-select">';
      for (var sv = 0; sv < supertonicVoices.length; sv++) {
        supertonicOptions += '<option value="' + supertonicVoices[sv][0] + '"' +
          (CFG.supertonicVoice === supertonicVoices[sv][0] ? ' selected' : '') + '>' +
          supertonicVoices[sv][1] + '</option>';
      }
      return supertonicOptions + '</select>';
    }
    // edge (default)
    return '<select id="va-voice-select"><option value="">Default</option>' +
      '<option value="en-US-JennyNeural"' + (CFG.ttsVoice === 'en-US-JennyNeural' ? ' selected' : '') + '>Jenny (US)</option>' +
      '<option value="en-US-GuyNeural"' + (CFG.ttsVoice === 'en-US-GuyNeural' ? ' selected' : '') + '>Guy (US)</option>' +
      '<option value="en-GB-SoniaNeural"' + (CFG.ttsVoice === 'en-GB-SoniaNeural' ? ' selected' : '') + '>Sonia (UK)</option>' +
      '<option value="en-GB-RyanNeural"' + (CFG.ttsVoice === 'en-GB-RyanNeural' ? ' selected' : '') + '>Ryan (UK)</option>' +
      '</select>';
  }

  // Re-render the engine-aware voice control + update its hint.
  function refreshVoiceControl() {
    var ctrl = document.getElementById('va-voice-control');
    if (ctrl) ctrl.innerHTML = voiceControlHTML();
    var hint = document.getElementById('va-voice-hint');
    if (hint) {
      if (CFG.ttsEngine === 'elevenlabs') hint.textContent = 'Paste an ElevenLabs voice_id';
      else if (CFG.ttsEngine === 'openai') hint.textContent = 'Choose an OpenAI voice name';
      else if (CFG.ttsEngine === 'browser') hint.textContent = 'Lang tag (e.g. en-GB) or OS voice name';
      else if (CFG.ttsEngine === 'supertonic-server') hint.textContent = 'Server-side Supertonic voice style (M1–M5 / F1–F5)';
      else if (CFG.ttsEngine === 'supertonic') hint.textContent = 'Browser-side Supertonic voice style (M1–M5 / F1–F5)';
      else hint.textContent = 'Choose an Edge (Microsoft) neural voice';
    }
    var engineHint = document.getElementById('va-engine-hint');
    if (engineHint) engineHint.textContent = CFG.ttsEngine === 'supertonic-server'
      ? 'Runs on the VPS; clients download only generated WAV audio'
      : (CFG.ttsEngine === 'supertonic'
        ? 'Optional browser mode; downloads about 400 MB and may fail on mobile'
        : (CFG.ttsEngine === 'edge' ? 'Edge = free, no key' : 'The selected engine may need a server API key'));
    refreshSupertonicOptions();
    wireVoiceControl();
  }

  // Attach handlers to whichever voice control is currently rendered.
  function wireVoiceControl() {
    var sel = document.getElementById('va-voice-select');
    if (sel) {
      sel.addEventListener('change', function () {
        if (CFG.ttsEngine === 'edge') { CFG.ttsVoice = sel.value; saveSettings(); }
        else if (CFG.ttsEngine === 'openai') { CFG.openaiVoice = sel.value; saveSettings(); }
        else if (CFG.ttsEngine === 'elevenlabs') {
          if (sel.value === '__custom__') {
            // Replace the select with a text input for pasting a voice_id.
            var ctrl = document.getElementById('va-voice-control');
            if (ctrl) {
              ctrl.innerHTML = '<input type="text" id="va-voice-input" value="' + CFG.elevenlabsVoice + '" placeholder="Paste ElevenLabs voice_id" style="width:180px;" spellcheck="false">';
              wireVoiceControl();
            }
          } else {
            CFG.elevenlabsVoice = sel.value;
            saveSettings();
          }
        } else if (CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server') {
          CFG.supertonicVoice = sel.value;
          saveSettings();
        }
      });
      return;
    }
    var input = document.getElementById('va-voice-input');
    if (input) {
      input.addEventListener('change', function () {
        var v = input.value.trim();
        if (CFG.ttsEngine === 'elevenlabs') CFG.elevenlabsVoice = v;
        else if (CFG.ttsEngine === 'browser') CFG.ttsVoice = v;
        saveSettings();
      });
    }
  }

  function refreshSupertonicOptions() {
    var visible = CFG.ttsEngine === 'supertonic' || CFG.ttsEngine === 'supertonic-server';
    ['va-supertonic-options', 'va-supertonic-quality', 'va-supertonic-speed'].forEach(function (id) {
      var row = document.getElementById(id);
      if (row) row.style.display = visible ? 'flex' : 'none';
    });
  }

  function wireSupertonicControls() {
    var lang = document.getElementById('va-supertonic-lang-select');
    if (lang) lang.addEventListener('change', function () {
      CFG.supertonicLang = lang.value;
      saveSettings();
    });
    var steps = document.getElementById('va-supertonic-steps-select');
    if (steps) steps.addEventListener('change', function () {
      CFG.supertonicSteps = parseInt(steps.value, 10) || 5;
      saveSettings();
    });
    var speed = document.getElementById('va-supertonic-speed-slider');
    if (speed) speed.addEventListener('input', function () {
      CFG.supertonicSpeed = parseFloat(speed.value) || 1.05;
      var label = document.getElementById('va-supertonic-speed-val');
      if (label) label.textContent = CFG.supertonicSpeed.toFixed(2) + '×';
      saveSettings();
    });
  }

  function wirePanel() {
    function bindToggle(id, key) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function () { CFG[key] = !CFG[key]; el.classList.toggle('va-on', CFG[key]); saveSettings(); });
    }
    bindToggle('va-tts-toggle', 'ttsEnabled');
    bindToggle('va-auto-toggle', 'autoListen');
    var liveToggle = document.getElementById('va-live-stt-toggle');
    if (liveToggle) liveToggle.addEventListener('click', function () {
      CFG.streamingSttEnabled = !CFG.streamingSttEnabled;
      liveToggle.classList.toggle('va-on', CFG.streamingSttEnabled);
      if (!CFG.streamingSttEnabled) closeLiveSttCapture();
      else if (STATE.audioStream) ensureLiveSttCapture();
      saveSettings();
    });

    // Crisp Replies toggle: make the AGENT answer short & direct via prompt.
    var crisp = document.getElementById('va-crisp-toggle');
    if (crisp) crisp.addEventListener('click', function () {
      CFG.crispPrompt = !CFG.crispPrompt;
      crisp.classList.toggle('va-on', CFG.crispPrompt);
      saveSettings();
    });

    // Truncate toggle: cap read-aloud length (speech layer only).
    var truncate = document.getElementById('va-truncate-toggle');
    if (truncate) truncate.addEventListener('click', function () {
      CFG.truncateEnabled = !CFG.truncateEnabled;
      truncate.classList.toggle('va-on', CFG.truncateEnabled);
      var row = document.getElementById('va-truncate-row');
      if (row) row.style.display = CFG.truncateEnabled ? 'flex' : 'none';
      saveSettings();
    });

    // Truncate char budget input.
    var truncInput = document.getElementById('va-truncate-input');
    if (truncInput) truncInput.addEventListener('change', function () {
      var v = parseInt(truncInput.value, 10);
      if (isNaN(v)) v = 450;
      v = Math.max(60, Math.min(4000, v));
      CFG.truncateChars = v;
      truncInput.value = v;
      saveSettings();
    });

    var sens = document.getElementById('va-sens-slider');
    if (sens) sens.addEventListener('input', function () {
      var v = parseInt(sens.value, 10);
      // Inverse of buildPanelHTML: sensVal 1..10 → threshold 0.86..0.32
      // (left = least sensitive, right = most sensitive)
      CFG.positiveSpeechThreshold = 0.92 - 0.06 * v;
      CFG.negativeSpeechThreshold = CFG.positiveSpeechThreshold - 0.15;
      document.getElementById('va-sens-val').textContent = v;
      if (STATE.vad) {
        STATE.vad.positiveSpeechThreshold = CFG.positiveSpeechThreshold;
        STATE.vad.negativeSpeechThreshold = CFG.negativeSpeechThreshold;
      }
      saveSettings();
    });

    // TTS Engine selector — switching engine re-renders the voice control.
    var engine = document.getElementById('va-engine-select');
    if (engine) engine.addEventListener('change', function () {
      CFG.ttsEngine = engine.value;
      refreshVoiceControl();
      saveSettings();
    });

    var testVoice = document.getElementById('va-test-voice');
    if (testVoice) testVoice.addEventListener('click', function (event) {
      event.preventDefault();
      unlockMobileAudio();
      testVoice.disabled = true;
      testVoice.textContent = 'Loading…';
      speakText('Voice playback is working.').then(function () {
        showToast('Voice: Playback test passed');
      }).catch(function (err) {
        console.error('[VA ' + vaTs() + '] [TEST] Playback test failed:', err);
        showToast('Voice: Playback test failed — check browser audio permission', 5000);
      }).finally(function () {
        testVoice.disabled = false;
        testVoice.textContent = 'Test voice';
      });
    });

    // VAD timing sliders — dynamic-range maps ms → frames at init/update time.
    bindRange('va-preroll-slider', 'va-preroll-val', 'preRollMs', 0, 900, 'ms');
    bindRange('va-minspeech-slider', 'va-minspeech-val', 'minSpeechMs', 100, 1200, 'ms');
    bindRange('va-endsil-slider', 'va-endsil-val', 'endSilenceMs', 200, 2000, 'ms');

    // Attach handlers to the engine-specific voice control rendered at build.
    wireVoiceControl();
    wireSupertonicControls();
  }

  // Generic range-slider binding: updates CFG[key], per-second label, saves,
  // and live-applies the VAD frame mapping if the VAD is already running.
  function bindRange(sliderId, labelId, key, min, max, suffix) {
    var el = document.getElementById(sliderId);
    if (!el) return;
    el.addEventListener('input', function () {
      var v = parseInt(el.value, 10);
      if (isNaN(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      CFG[key] = v;
      var label = document.getElementById(labelId);
      if (label) label.textContent = v + suffix;
      applyVadConfigToActive();
      saveSettings();
    });
  }

  // Push the current CFG VAD values into a live Silero VAD instance, mapping
  // milliseconds to frames (legacy model: 1536 samples/frame @ 16kHz = 96ms).
  function applyVadConfigToActive() {
    if (!STATE.vad) return;
    var framesPerMs = 1 / 96;
    try {
      STATE.vad.setOptions({
        positiveSpeechThreshold: CFG.positiveSpeechThreshold,
        negativeSpeechThreshold: CFG.negativeSpeechThreshold,
        minSpeechFrames: Math.max(2, Math.round(CFG.minSpeechMs * framesPerMs)),
        preSpeechPadFrames: Math.max(0, Math.round(CFG.preRollMs * framesPerMs)),
        redemptionFrames: Math.max(2, Math.round(CFG.endSilenceMs * framesPerMs)),
      });
    } catch (e) { console.warn('[VA] applyVadConfigToActive:', e); }
  }

  function openPanel() {
    if (!panel) return;
    panel.classList.add('va-open');
    STATE.panelOpen = true;
  }
  function closePanel() { if (panel) panel.classList.remove('va-open'); STATE.panelOpen = false; }

  // ═══════════════════════════════════════════════════════════════
  //  Visual State
  // ═══════════════════════════════════════════════════════════════

  function setPhase(phase) {
    STATE.phase = phase;
    if (!orb) return;
    orb.className = '';
    levelBar.classList.remove('va-visible');
    statusLabel.classList.remove('va-visible');
    switch (phase) {
      case 'idle': orb.innerHTML = '🎤'; break;
      case 'listening':
        orb.innerHTML = '🎙️'; orb.classList.add('va-listening');
        levelBar.classList.add('va-visible');
        statusLabel.textContent = STATE.liveTranscript ? liveTranscriptStatus('Listening') : 'Listening…';
        statusLabel.classList.add('va-visible'); break;
      case 'transcribing':
        orb.innerHTML = '⏳'; orb.classList.add('va-processing');
        statusLabel.textContent = STATE.liveTranscript ? liveTranscriptStatus('Finalizing') : 'Transcribing…';
        statusLabel.classList.add('va-visible'); break;
      case 'processing':
        orb.innerHTML = '🤖'; orb.classList.add('va-processing');
        statusLabel.textContent = 'Thinking…'; statusLabel.classList.add('va-visible'); break;
      case 'speaking':
        orb.innerHTML = '🔊'; orb.classList.add('va-speaking');
        statusLabel.textContent = 'Speaking…'; statusLabel.classList.add('va-visible'); break;
    }
  }

  function updateLevelBar(rms) {
    if (!levelFill) return;
    levelFill.style.width = Math.min(100, (rms / 0.15) * 100) + '%';
  }

  function showRipple() {
    var c = document.getElementById('va-ripple-container');
    if (!c) return;
    var r = document.createElement('div');
    r.className = 'va-ripple';
    c.appendChild(r);
    setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 1000);
  }

  function showToast(msg, dur) {
    if (typeof window.showToast === 'function') window.showToast(msg, dur || 3000);
    else console.log('[VA] ' + msg);
  }

  function liveTranscriptStatus(prefix) {
    var text = String(STATE.liveTranscript || '').trim();
    if (text.length > 120) text = '…' + text.slice(-119);
    return prefix + ' · ' + text;
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Hook — definitive response completion
  // ═══════════════════════════════════════════════════════════════

  function hookSSE() {
    if (STATE.sseHooked) return;
    STATE.sseHooked = true;

    var OrigES = window.EventSource;
    if (!OrigES) return;

    function PatchedES(url, config) {
      var es = new OrigES(url, config);
      var streamId = streamIdFromUrl(url);
      if (streamId) {
        TURN.bindStream(streamId);
        if (!STREAM_SPEECH.streamId || STREAM_SPEECH.streamId !== streamId) {
          STREAM_SPEECH.streamCreatedAt = Date.now();
          vaDbg('SSE', 'Stream created: ' + streamId + ' (bound to open turn)');
        }
      }

      es.addEventListener('token', function (e) {
        if (!STATE.expectingReply || !streamId) return;
        try {
          var tokenData = JSON.parse(e.data);
          var delta = String((tokenData && tokenData.text) || '');
          if (!delta) return;
          if (!TURN.bindStream(streamId)) return;
          if (!STREAM_SPEECH.sawTokens) {
            STATE.firstTokenAt = Date.now();
            vaDbg('SSE-TIMING', 'FIRST TOKEN ' + (STATE.sentAt ? (STATE.firstTokenAt - STATE.sentAt) + 'ms after send' : '') + ' | stream=' + streamId + ' delta="' + delta.slice(0, 40) + '"');
          }
          armReplyWatchdog();
          acceptStreamingDelta(streamId, delta);
        } catch (err) {
          console.warn('[VA ' + vaTs() + '] [SSE] token parse error:', err);
        }
      });

      es.addEventListener('done', function (e) {
        vaDbg('SSE-TIMING', 'DONE event (+' + (Date.now() - STATE.sentAt) + 'ms vs send, +' + (Date.now() - STATE.firstTokenAt) + 'ms vs first token) stream=' + streamId);
        try {
          var data = JSON.parse(e.data);
          var msgs = (data.session && data.session.messages) || [];
          var lastAsst = null;
          for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') { lastAsst = msgs[i]; break; }
          }
          var text = lastAsst ? (lastAsst.content || '').trim() : '';
          text = text.replace(/ thinking[\s\S]*?<\/think>/g, '').trim();
          vaDbg('SSE', 'done: text=' + (text ? text.slice(0, 80) + '…' : '(empty)') + ' expectingReply=' + STATE.expectingReply);

          STATE.responseText = text;

          if (STATE.expectingReply) {
            var accepted = TURN.noteDone(text, streamId);
            vaDbg('TURN', 'noteDone returned: ' + accepted + ' snap=' + JSON.stringify(TURN.snapshot()));
          }
        } catch (err) {
          console.warn('[VA ' + vaTs() + '] [SSE] done parse error, deferring empty completion:', err);
          if (STATE.expectingReply) TURN.noteDone('', streamId);
        }
      });

      return es;
    }
    PatchedES.prototype = OrigES.prototype;
    PatchedES.CONNECTING = OrigES.CONNECTING;
    PatchedES.OPEN = OrigES.OPEN;
    PatchedES.CLOSED = OrigES.CLOSED;
    window.EventSource = PatchedES;

    console.log('[VA ' + vaTs() + '] [SSE] EventSource hooked for response detection');
  }

  // ═══════════════════════════════════════════════════════════════
  //  Silero VAD — neural network speech detection from CDN
  // ═══════════════════════════════════════════════════════════════

  var VAD_CDN = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/+esm';
  var CAN_WASM = null; // null=unknown, true=wasm-unsafe-eval allowed

  function testWasmEval() {
    if (CAN_WASM !== null) return Promise.resolve(CAN_WASM);
    return new Promise(function (resolve) {
      try {
        // Minimal WASM compile to test if 'wasm-unsafe-eval' is allowed
        var bytes = new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
          0x03, 0x02, 0x01, 0x00,
          0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
        ]);
        WebAssembly.compile(bytes).then(function () {
          CAN_WASM = true;
          console.log('[VA] WASM compile OK (wasm-unsafe-eval permitted)');
          resolve(true);
        }, function () {
          CAN_WASM = false;
          console.warn('[VA] WASM compile blocked by CSP');
          resolve(false);
        });
      } catch (e) {
        console.warn('[VA] WASM test failed:', e);
        resolve(false);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Live partial STT — PCM stream to WhisperLiveKit
  // ═══════════════════════════════════════════════════════════════

  function liveSttUrl() {
    var scheme = (CFG.streamingSttSecure || location.protocol === 'https:') ? 'wss:' : 'ws:';
    var host = CFG.streamingSttHost || location.hostname || '127.0.0.1';
    return scheme + '//' + host + ':' + CFG.streamingSttPort + '/asr?language=' +
      encodeURIComponent(CFG.streamingSttLanguage || 'auto') + '&mode=full';
  }

  async function ensureLiveSttCapture() {
    if (!CFG.streamingSttEnabled || !STATE.audioStream || !window.LiveSttSession) return false;
    if (STATE.liveSttContext && STATE.liveSttProcessor) {
      if (STATE.liveSttContext.state === 'suspended') {
        try { await STATE.liveSttContext.resume(); } catch (_) {}
      }
      return true;
    }

    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio unavailable');
      var ctx = new AudioCtx();
      try { await ctx.resume(); } catch (_) {}
      var source = ctx.createMediaStreamSource(STATE.audioStream);
      // ScriptProcessor is intentionally used for broad mobile compatibility.
      // The work is tiny (mono resample + int16 conversion); inference stays on VPS.
      var processor = ctx.createScriptProcessor(4096, 1, 1);
      var gain = ctx.createGain();
      gain.gain.value = 0;
      var encoder = new window.StreamingPcm16Encoder(ctx.sampleRate, 16000);
      // One LiveSttSession per utterance (matches WhisperLiveKit's protocol of
      // one WS connection + one ready_to_stop per utterance). Routing PCM to
      // whichever session is CURRENT means a rapid next utterance's new session
      // never clobbers the previous utterance's pending finish().
      processor.onaudioprocess = function (event) {
        var sess = STATE.liveStt;
        if (!sess || !sess.active) return;
        var pcm = encoder.encode(event.inputBuffer.getChannelData(0));
        if (pcm.byteLength) sess.pushPcm(pcm);
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);
      STATE.liveSttContext = ctx;
      STATE.liveSttSource = source;
      STATE.liveSttProcessor = processor;
      STATE.liveSttGain = gain;
      STATE.liveSttEncoder = encoder;
      vaDbg('STT', 'Live STT PCM capture initialized at ' + ctx.sampleRate + ' Hz, ws=' + liveSttUrl());
      return true;
    } catch (err) {
      console.warn('[VA ' + vaTs() + '] [STT] Live STT capture init failed:', err);
      return false;
    }
  }

  function makeLiveSttSession() {
    return new window.LiveSttSession({
      url: liveSttUrl(),
      preRollBytes: Math.max(16000, Math.round(16000 * 2 * CFG.preRollMs / 1000)),
      onTranscript: function (text) {
        STATE.liveTranscript = text;
        if (statusLabel && (STATE.phase === 'listening' || STATE.phase === 'transcribing')) {
          statusLabel.textContent = liveTranscriptStatus(STATE.phase === 'transcribing' ? 'Finalizing' : 'Listening');
          statusLabel.classList.add('va-visible');
        }
      },
      onError: function (err) {
        console.warn('[VA ' + vaTs() + '] [STT] Live STT unavailable; final batch STT remains active:', err);
        if (!STATE.liveSttErrorShown) {
          STATE.liveSttErrorShown = true;
          showToast('Voice: Live transcript unavailable — final transcription still works', 4000);
        }
      },
    });
  }

  function startLiveSttUtterance() {
    STATE.liveTranscript = '';
    if (!CFG.streamingSttEnabled) return;
    ensureLiveSttCapture().then(function (ready) {
      if (!ready) return;
      // Always create a FRESH session for this utterance. The previous one keeps
      // finalizing on its own (its finish() promise was captured at speech end),
      // so a quick follow-up no longer aborts the in-flight ready_to_stop.
      var prev = STATE.liveStt;
      var session = makeLiveSttSession();
      // Carry the pre-roll PCM accumulated while the mic was idle into the new
      // session so the utterance's leading edge is still transcribed.
      if (prev && prev.ring && prev.ring.parts && prev.ring.parts.length) {
        session.ring.parts = prev.ring.parts.slice();
        session.ring.bytes = prev.ring.bytes;
      }
      STATE.liveStt = session;
      if (!STATE.liveSttSessions) STATE.liveSttSessions = [];
      STATE.liveSttSessions.push(session);
      // Trim registry: drop sessions that already finalized or were closed so
      // a long conversation doesn't accumulate dead WebSocket refs.
      STATE.liveSttSessions = STATE.liveSttSessions.filter(function (s) {
        return s !== session && (s.active || s.finishing);
      });
      session.start();
    });
  }

  function finishLiveSttUtterance() {
    if (STATE.liveStt) return STATE.liveStt.finish();
    return Promise.resolve('');
  }

  function cancelLiveSttUtterance() {
    if (STATE.liveStt && !STATE.liveStt.finishing) STATE.liveStt.close();
    STATE.liveTranscript = '';
  }

  function closeLiveSttCapture() {
    if (STATE.liveSttSessions) {
      for (var i = 0; i < STATE.liveSttSessions.length; i++) {
        try { STATE.liveSttSessions[i].close(); } catch (_) {}
      }
      STATE.liveSttSessions = [];
    }
    if (STATE.liveStt) { try { STATE.liveStt.close(); } catch (_) {} }
    if (STATE.liveSttProcessor) {
      try { STATE.liveSttProcessor.disconnect(); } catch (_) {}
      STATE.liveSttProcessor.onaudioprocess = null;
    }
    if (STATE.liveSttSource) { try { STATE.liveSttSource.disconnect(); } catch (_) {} }
    if (STATE.liveSttGain) { try { STATE.liveSttGain.disconnect(); } catch (_) {} }
    if (STATE.liveSttContext) { try { STATE.liveSttContext.close(); } catch (_) {} }
    STATE.liveStt = null;
    STATE.liveSttContext = null;
    STATE.liveSttSource = null;
    STATE.liveSttProcessor = null;
    STATE.liveSttGain = null;
    STATE.liveSttEncoder = null;
  }

  async function loadVAD() {
    if (STATE.vad) return STATE.vad;
    var t0 = performance.now();
    vaDbg('VAD', 'loadVAD start');

    var wasmOk = await testWasmEval();
    if (!wasmOk) {
      console.error('[VA ' + vaTs() + '] [VAD] WebAssembly blocked by CSP — Silero VAD cannot run');
      showToast('Voice: WASM blocked by security policy');
      return null;
    }

    // Critical: procure the mic stream OURSELVES and pass it into Silero.
    // In non-secure contexts (plain HTTP on a non-localhost address) the
    // browser does not expose navigator.mediaDevices — Silero's internal
    // getUserMedia would crash with "reading 'getUserMedia' of undefined".
    if (!STATE.audioStream) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        console.error('[VA ' + vaTs() + '] [VAD] navigator.mediaDevices unavailable — requires localhost or HTTPS');
        showToast('Voice: Mic needs localhost or HTTPS connection');
        return null;
      }
      try {
        STATE.audioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        console.error('[VA ' + vaTs() + '] [VAD] getUserMedia denied:', e);
        showToast('Voice: Microphone access denied');
        return null;
      }
    }

    try {
      var mod = await import(VAD_CDN);
      var MicVAD = mod.MicVAD;
      vaDbg('VAD', 'Silero module code loaded (' + Math.round(performance.now() - t0) + 'ms incl. WASM/ORT init)');

      // ms → frames: legacy Silero model uses 1536 samples/frame @ 16kHz = 96ms.
      var framesPerMs = 1 / 96;

      STATE.vad = await MicVAD.new({
        stream: STATE.audioStream,   // use OUR stream — library never calls getUserMedia
        positiveSpeechThreshold: CFG.positiveSpeechThreshold,
        negativeSpeechThreshold: CFG.negativeSpeechThreshold,
        minSpeechFrames: Math.max(2, Math.round(CFG.minSpeechMs * framesPerMs)),
        preSpeechPadFrames: Math.max(0, Math.round(CFG.preRollMs * framesPerMs)),
        redemptionFrames: Math.max(2, Math.round(CFG.endSilenceMs * framesPerMs)),
        onSpeechStart: function () {
          vaDbg('VAD', 'Speech START (barge-in=' + (STATE.ttsActive || STATE.phase === 'speaking') + ', openCaptures=' + STATE.openSpeechCaptures + ')');
          startLiveSttUtterance();
          // Full-duplex barge-in: stop the current utterance immediately but keep
          // the conversation session alive. The captured speech becomes the next
          // natural turn (or a steer if the agent is still running).
          if (STATE.ttsActive || STATE.phase === 'speaking') {
            vaDbg('VAD', 'Barge-in — interrupting TTS');
            stopTTS();
            clearExpectingReply();
            TURN.reset();
            resetStreamingResponse('', false);
          }
          STATE.openSpeechCaptures += 1;
          TURN.beginStt();
          // Keep the microphone visibly armed without pretending the active
          // transcription/agent turn stopped. A follow-up may become a steer.
          if (STATE.phase !== 'transcribing' && STATE.phase !== 'processing') {
            setPhase('listening');
          } else if (statusLabel) {
            statusLabel.textContent = STATE.phase === 'transcribing'
              ? 'Listening · transcribing previous…'
              : 'Listening · response in progress…';
            statusLabel.classList.add('va-visible');
          }
        },
        onSpeechEnd: function (audio) {
          var durMs = audio && audio.length ? Math.round(audio.length / 16) : 0; // 16kHz → ms
          vaDbg('VAD', 'Speech END (' + (audio ? audio.length : 0) + ' samples ≈ ' + durMs + 'ms)');
          STATE.lastSpeechEndAt = Date.now();
          var sttDonePromise = finishLiveSttUtterance();
          if (STATE.openSpeechCaptures > 0) STATE.openSpeechCaptures -= 1;
          else TURN.beginStt(); // defensive: keep begin/end balanced
          // Silero hands us the full utterance INCLUDING pre-roll padding —
          // encode to WAV ourselves; never use MediaRecorder (it starts too
          // late and loses the first ~200-400ms of speech).
          finishWithAudio(audio, sttDonePromise);
        },
        onVADMisfire: function () {
          vaDbg('VAD', 'Misfire — too short, cancelling');
          cancelLiveSttUtterance();
          if (STATE.openSpeechCaptures > 0) STATE.openSpeechCaptures -= 1;
          TURN.endStt();
          recoverAfterStt();
        },
      });

      await ensureLiveSttCapture();
      vaDbg('VAD', 'Silero model + live STT ready (total ' + Math.round(performance.now() - t0) + 'ms)');
      return STATE.vad;
    } catch (e) {
      console.error('[VA ' + vaTs() + '] [VAD] Silero VAD init failed:', e);
      showToast('Voice: Speech detection init failed');
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Recording — Silero hands us the audio buffer directly (incl. pre-roll).
  //  We encode to WAV client-side and POST to /api/transcribe.
  // ═══════════════════════════════════════════════════════════════

  // Encode a Float32Array (16kHz mono) into a WAV Blob.
  function encodeWav(samples) {
    var numChannels = 1;
    var sampleRate = 16000;
    var bitDepth = 16;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = samples.length * blockAlign;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    // RIFF chunk
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');

    // fmt chunk
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);                 // fmt chunk size
    view.setUint16(20, 1, true);                  // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // data chunk
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // 16-bit PCM samples
    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function writeAscii(view, offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // Called by Silero's onSpeechEnd with the captured utterance.
  function finishWithAudio(audio, sttDonePromise) {
    if (!audio || !audio.length) { TURN.endStt(); recoverAfterStt(); return; }

    // Guard: require the utterance to actually contain speech energy, else
    // the "silence/misfire → instant transcribe" loop would spam the STT.
    var peak = 0;
    for (var i = 0; i < audio.length; i += 40) {
      var a = Math.abs(audio[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.002) {  // effectively silent clip
      vaDbg('STT', 'utterance too quiet (peak=' + peak.toFixed(4) + '), ignoring');
      TURN.endStt();
      recoverAfterStt();
      return;
    }

    var blob = encodeWav(audio);
    if (blob.size < 1500) { TURN.endStt(); recoverAfterStt(); return; }

    setPhase('transcribing');
    var generation = STATE.stopGeneration;
    var t0 = performance.now();
    vaDbg('STT', 'Enqueued transcribe (' + blob.size + ' bytes wav, live-final-pending=' + !!sttDonePromise + ')');

    STT_QUEUE.add(function () {
      if (generation !== STATE.stopGeneration) return '';

      // Await the live STT finish promise — resolves when WhisperLiveKit
      // confirms it's done processing (ready_to_stop message), not when
      // we guess it's done with an arbitrary delay.
      if (sttDonePromise) {
        return sttDonePromise.then(function (liveText) {
          var clean = String(liveText || '').trim();
          if (clean.length >= 2) {
            vaDbg('STT', 'Live STT transcript (server-confirmed) in ' + Math.round(performance.now() - t0) + 'ms: "' + clean.slice(0, 60) + '"');
            return clean;
          }
          vaDbg('STT-WARN', 'Live STT EMPTY (' + Math.round(performance.now() - t0) + 'ms) → batch fallback');
          return window.withVoiceTimeout(function () { return batchTranscribe(blob); }, 45000);
        }).catch(function (err) {
          vaDbg('STT-WARN', 'Live STT failed (' + Math.round(performance.now() - t0) + 'ms):', err ? String(err.message || err) : 'unknown');
          return window.withVoiceTimeout(function () { return batchTranscribe(blob); }, 45000);
        });
      }

      return window.withVoiceTimeout(function () { return batchTranscribe(blob); }, 45000);
    }).then(function (text) {
      TURN.endStt();
      if (generation !== STATE.stopGeneration) return;
      if (text && text.trim().length > 0) {
        sendToAgent(text.trim());
      } else {
        vaDbg('STT-WARN', 'Transcribe returned empty text');
        recoverAfterStt();
      }
    }).catch(function (err) {
      TURN.endStt();
      if (generation !== STATE.stopGeneration) return;
      console.error('[VA ' + vaTs() + '] [STT] Transcribe failed:', err);
      showToast('Voice: Transcription failed');
      recoverAfterStt();
    });
  }

  function batchTranscribe(blob) {
    var t0 = performance.now();
    return transcribeAudio(blob).then(function (text) {
      vaDbg('STT', 'Batch transcribe returned in ' + Math.round(performance.now() - t0) + 'ms: "' + String(text).slice(0, 60) + '"');
      return text;
    });
  }

  function recoverAfterStt() {
    var phase = window.voicePhaseAfterStt({
      pendingStt: TURN.snapshot().pendingStt,
      expectingReply: STATE.expectingReply,
      ttsActive: STATE.ttsActive,
    });
    setPhase(phase);
    if (TURN.snapshot().pendingStt === 0) releaseDeferredStreamingSpeech();
    if (phase === 'listening') resetSileroMic();
  }

  function resetSileroMic() {
    // Stop VAD, then restart on a clean slate
    if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
    setTimeout(function () {
      if (STATE.phase === 'listening' && STATE.vad) {
        try { STATE.vad.start(); } catch (_) {}
      }
    }, 300);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Transcription & Agent Communication
  // ═══════════════════════════════════════════════════════════════

  async function transcribeAudio(blob) {
    var formData = new FormData();
    var ext = blob.type.includes('wav') ? '.wav' : (blob.type.includes('webm') ? '.webm' : '.ogg');
    formData.append('file', blob, 'voice' + ext);
    var resp = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    return data.transcript || '';
  }

  // Send speech into one conversational turn. A follow-up that finishes STT
  // during the several-second /api/chat/start gap waits for the stream id and
  // becomes a steer instead of leaking into the normal message queue.
  function sendToAgent(text) {
    var liveStream = activeStreamId();
    var hadOpenTurn = STATE.expectingReply && TURN.snapshot().waiting;
    var fromSpeechEnd = STATE.lastSpeechEndAt ? (Date.now() - STATE.lastSpeechEndAt) : null;
    vaDbg('SEND', 'sendToAgent: text="' + text.slice(0, 60) + '" liveStream=' + liveStream + ' hadOpenTurn=' + hadOpenTurn +
      ' expectingReply=' + STATE.expectingReply + ' turnWaiting=' + TURN.snapshot().waiting +
      (fromSpeechEnd != null ? ' | ' + fromSpeechEnd + 'ms post speech-end' : ''));
    // Voice may join a turn started from the keyboard. Treat that as steerable
    // conversation too rather than letting the busy composer choose a mode.
    if (!hadOpenTurn && liveStream) {
      TURN.beginAgentTurn();
      TURN.bindStream(liveStream);
      hadOpenTurn = true;
    }
    setPhase('processing');
    STATE.responseDone = false;
    STATE.responseText = '';
    STATE.expectingReply = true;
    STATE.sentAt = Date.now();
    STATE.firstTokenAt = 0;
    armReplyWatchdog();

    var outText = text;
    if (CFG.crispPrompt && CFG.crispDirective) {
      outText = text + '\n\n(Instruction: ' + CFG.crispDirective + ')';
    }

    if (hadOpenTurn) {
      deliverNaturalFollowup(outText);
      return;
    }

    var previousStream = TURN.snapshot().currentStreamId || activeStreamId();
    resetStreamingResponse('', true);
    TURN.beginAgentTurn({ afterStreamId: previousStream });
    sendViaComposer(outText);
  }

  function deliverNaturalFollowup(outText) {
    var steerT0 = Date.now();
    TURN.beginDelivery();
    window.waitForVoiceSteerTarget(function () {
      var snap = TURN.snapshot();
      return {
        streamId: activeStreamId(),
        turnCompleted: snap.turnCompleted,
      };
    }, { timeoutMs: 10000, pollMs: 50 }).then(function (targetStream) {
      if (!targetStream || typeof _trySteer !== 'function') {
        return startFreshFollowup(outText);
      }

      TURN.bindStream(targetStream);
      vaDbg('STEER', 'Active stream ready — steering follow-up (waited ' + (Date.now() - steerT0) + 'ms)');
      return _trySteer(outText, /*explicitSteer=*/false).then(function (accepted) {
        if (accepted) {
          vaDbg('STEER', 'Steer accepted by stream ' + targetStream);
          clearVoiceComposerDraft(outText);
          resetStreamingResponse(targetStream, true);
          TURN.resolveDelivery('steer');
          setPhase('processing');
          return;
        }
        vaDbg('STEER-WARN', 'Steer closed before delivery — continuing as next turn');
        return startFreshFollowup(outText);
      });
    }).catch(function (err) {
      console.warn('[VA ' + vaTs() + '] [STEER] Natural follow-up routing failed:', err);
      return startFreshFollowup(outText);
    });
  }

  function startFreshFollowup(outText) {
    var previousStream = TURN.snapshot().currentStreamId || activeStreamId();
    clearVoiceComposerDraft(outText);
    return waitForAgentIdle(15000).then(function () {
      resetStreamingResponse('', true);
      TURN.beginAgentTurn({ afterStreamId: previousStream });
      TURN.resolveDelivery('new-turn');
      sendViaComposer(outText);
    });
  }

  function waitForAgentIdle(timeoutMs) {
    var started = Date.now();
    return new Promise(function (resolve) {
      function check() {
        var busy = typeof S !== 'undefined' && (S.busy || activeStreamId());
        if (!busy || Date.now() - started >= timeoutMs) { resolve(!busy); return; }
        setTimeout(check, 50);
      }
      check();
    });
  }

  function clearVoiceComposerDraft(text) {
    var textarea = document.getElementById('msg');
    if (!textarea) return;
    var value = String(textarea.value || '').trim();
    var plain = String(text || '').trim();
    if (value === plain || value === '/steer ' + plain) {
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Inject into the composer and trigger the WebUI's global send().
  function sendViaComposer(text) {
    var textarea = document.getElementById('msg');
    if (!textarea) { console.error('[VA ' + vaTs() + '] [SEND] No #msg textarea'); clearExpectingReply(); resetSileroMic(); return; }

    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(function () {
      if (typeof send === 'function') send();
      else {
        var evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        textarea.dispatchEvent(evt);
      }

    }, 100);
  }

  function armReplyWatchdog() {
    if (STATE.replyWatchdog) clearTimeout(STATE.replyWatchdog);
    STATE.replyWatchdog = setTimeout(function () {
      STATE.replyWatchdog = null;
      if (!STATE.expectingReply || STATE.responseDone) return;
      console.warn('[VA ' + vaTs() + '] [WATCHDOG] Response did not complete in 180s, recovering voice state');
      TURN.reset();
      resetStreamingResponse('', true);
      clearExpectingReply();
      setPhase('idle');
      if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
    }, 180000);
  }

  // Stop awaiting a reply (after TTS finishes or on abort).
  function clearExpectingReply() {
    STATE.expectingReply = false;
    if (STATE.replyWatchdog) {
      clearTimeout(STATE.replyWatchdog);
      STATE.replyWatchdog = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Streaming response text → sentence TTS
  // ═══════════════════════════════════════════════════════════════

  function resetStreamingResponse(streamId, cancelPlayback) {
    if (cancelPlayback) stopTTS();
    STREAM_TEXT.reset(streamId || '');
    STREAM_SPEECH.streamId = String(streamId || '');
    STREAM_SPEECH.sawTokens = false;
    STREAM_SPEECH.deferred = [];
    STREAM_SPEECH.chain = Promise.resolve();
    STREAM_SPEECH.playbackToken = null;
    STREAM_SPEECH.finalizing = false;
  }

  function acceptStreamingDelta(streamId, delta) {
    if (STREAM_SPEECH.streamId !== streamId) resetStreamingResponse(streamId, true);
    STREAM_SPEECH.sawTokens = true;
    var sentences = STREAM_TEXT.push(delta);
    if (!sentences.length) return;
    var snap = TURN.snapshot();
    if (snap.pendingStt || snap.pendingDelivery) {
      Array.prototype.push.apply(STREAM_SPEECH.deferred, sentences);
      return;
    }
    for (var i = 0; i < sentences.length; i++) queueStreamingSentence(sentences[i]);
  }

  function releaseDeferredStreamingSpeech() {
    var snap = TURN.snapshot();
    if (snap.pendingStt || snap.pendingDelivery || !STREAM_SPEECH.deferred.length) return;
    var ready = STREAM_SPEECH.deferred.splice(0);
    for (var i = 0; i < ready.length; i++) queueStreamingSentence(ready[i]);
  }

  function queueStreamingSentence(sentence) {
    sentence = String(sentence || '').trim();
    if (!sentence) return;
    // Strip markdown/emoji and check what is actually left to speak. A sentence
    // that reduces to nothing (e.g. a lone emoji like "😄") must NOT be sent to
    // TTS — Supertonic/Edge reject it with HTTP 400 and the uncaught error
    // kills the final spoken sentence ("final response miss sometimes").
    var speakable = crispify(sentence);
    if (!String(speakable || '').trim()) {
      vaDbg('TTS-SKIP', 'non-speakable sentence (empty after clean): "' + sentence.slice(0, 40) + '"');
      return;
    }
    vaDbg('TTS', 'queueStreamingSentence: "' + sentence.slice(0, 60) + '" ttsEnabled=' + CFG.ttsEnabled +
      ' streamDelay=' + (STREAM_SPEECH.streamCreatedAt ? (Date.now() - STREAM_SPEECH.streamCreatedAt) + 'ms' : '-'));
    if (!CFG.ttsEnabled) return;
    if (STREAM_SPEECH.playbackToken === null || !PLAYBACK.isCurrent(STREAM_SPEECH.playbackToken)) {
      STREAM_SPEECH.playbackToken = PLAYBACK.begin();
    }
    var token = STREAM_SPEECH.playbackToken;
    var streamId = STREAM_SPEECH.streamId;

    // Prefetch: kick off the TTS fetch for this sentence while the previous
    // one is still playing, so audio is ready when playback reaches it.
    var prefetchPromise = prefetchSentenceAudio(sentence, token, streamId);

    STREAM_SPEECH.chain = STREAM_SPEECH.chain.catch(function (err) {
      console.warn('[VA ' + vaTs() + '] [TTS] Streaming TTS chunk failed; continuing:', err);
    }).then(function () {
      if (!PLAYBACK.isCurrent(token) || STREAM_SPEECH.streamId !== streamId) return;
      setPhase('speaking');
      return prefetchPromise.then(function (chunks) {
        if (!PLAYBACK.isCurrent(token) || STREAM_SPEECH.streamId !== streamId) return;
        vaDbg('TTS', 'Playing sentence "' + sentence.slice(0, 40) + '" with ' + (chunks ? chunks.length : 0) + ' prefetched chunks');
        return playPrefetchedSentence(sentence, token, chunks);
      }).then(function () {
        if (!PLAYBACK.isCurrent(token) || STREAM_SPEECH.streamId !== streamId) return;
        if (!STREAM_SPEECH.finalizing && STATE.expectingReply) setPhase('processing');
      });
    });
  }

  // Prefetch TTS audio for a sentence. Returns a Promise<array of {url, text}>.
  // Falls back gracefully — if prefetch fails, speakText will re-fetch.
  // Fetches are serialized via TTS_FETCH_CHAIN to prevent 429 rate limiting.
  var TTS_FETCH_CHAIN = Promise.resolve();
  function serializedTtsFetch(text, token, streamId) {
    var run = TTS_FETCH_CHAIN.then(function () {
      return fetchAudioBlob(text);
    }).then(function (url) {
      // Small gap between consecutive TTS requests to avoid 429 rate limiting
      return new Promise(function (resolve) { setTimeout(function () { resolve(url); }, 200); });
    });
    // Keep the chain alive even if this fetch fails
    TTS_FETCH_CHAIN = run.then(function () {}, function () {});
    return run.then(function (url) {
      if (!PLAYBACK.isCurrent(token) || STREAM_SPEECH.streamId !== streamId) {
        if (url) URL.revokeObjectURL(url);
        return null;
      }
      return { url: url, text: text };
    }).catch(function () { return null; });
  }

  function prefetchSentenceAudio(sentence, token, streamId) {
    var prose = crispify(sentence);
    var sentences = splitIntoSentences(prose);
    var chunks = chunkSentences(sentences, CFG.ttsChunkSize);
    if (!chunks.length) return Promise.resolve([]);
    // For browser engine, no prefetch needed
    if (CFG.ttsEngine === 'browser') return Promise.resolve(null);
    // Serialize fetches: chain them so only one TTS request is in-flight
    var result = Promise.resolve([]);
    for (var i = 0; i < chunks.length; i++) {
      (function (chunk) {
        result = result.then(function (acc) {
          return serializedTtsFetch(chunk, token, streamId).then(function (item) {
            if (!item) {
              // A chunk failed to prefetch (429/400/network). Abort the whole
              // prefetch so playPrefetchedSentence falls back to speakText,
              // which re-fetches EVERY chunk and never silently drops a
              // sentence. Dropping one chunk here = text visible on screen but
              // a spoken sentence missing ("final response miss sometimes").
              acc.failed = true;
              return acc;
            }
            acc.push(item);
            return acc;
          });
        });
      })(chunks[i]);
    }
    return result.then(function (acc) {
      if (acc.failed) return null; // fall back to speakText (full robust fetch)
      return acc;
    });
  }

  function playPrefetchedSentence(sentence, token, prefetched) {
    // If we have prefetched URLs, play them directly (skip re-fetching)
    if (prefetched && prefetched.length) {
      return playPrefetchedChunks(prefetched, token);
    }
    // Fallback to normal speakText path
    return speakText(sentence, token);
  }

  function playPrefetchedChunks(chunks, playbackToken) {
    STATE.ttsActive = true;
    var chain = Promise.resolve();
    for (var i = 0; i < chunks.length; i++) {
      if (!chunks[i] || !chunks[i].url) continue;
      chain = chain.then(function (idx) {
        return function () {
          if (!STATE.ttsActive || !PLAYBACK.isCurrent(playbackToken)) return;
          var chunk = chunks[idx];
          if (!chunk || !chunk.url) return;
          return playAudioURL(chunk.url, playbackToken).then(function (completed) {
            return completed;
          });
        };
      }(i));
    }
    return chain.then(function () {
      if (PLAYBACK.isCurrent(playbackToken)) STATE.ttsActive = false;
    });
  }

  function finishVoiceCycle() {
    clearExpectingReply();
    setPhase('idle');
    if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
    else if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
  }

  function finalizeStreamingResponse(text) {
    text = String(text || '').trim();
    vaDbg('RESP', 'finalizeStreamingResponse: text=' + (text ? text.slice(0, 80) + '…' : '(empty)') +
      ' sawTokens=' + STREAM_SPEECH.sawTokens + ' ttsEnabled=' + CFG.ttsEnabled);
    if (!CFG.ttsEnabled || !text) {
      finishVoiceCycle();
      return;
    }

    if (!STREAM_SPEECH.sawTokens) {
      onAgentResponseComplete(text);
      return;
    }

    releaseDeferredStreamingSpeech();
    var tail = STREAM_TEXT.flush();
    if (tail) queueStreamingSentence(tail);
    STREAM_SPEECH.finalizing = true;
    var token = STREAM_SPEECH.playbackToken;
    STREAM_SPEECH.chain.then(function () {
      if (token !== null && !PLAYBACK.isCurrent(token)) return;
      finishVoiceCycle();
    }).catch(function (err) {
      console.error('[VA ' + vaTs() + '] [TTS] Streaming response playback failed:', err);
      finishVoiceCycle();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  Response Complete → fallback full-response TTS
  // ═══════════════════════════════════════════════════════════════

  function onAgentResponseComplete(text) {
    vaDbg('RESP', 'onAgentResponseComplete: text=' + (text ? text.slice(0, 80) + '…' : '(empty)') + ' ttsEnabled=' + CFG.ttsEnabled);
    if (!CFG.ttsEnabled || !text.trim()) {
      clearExpectingReply();
      if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
      else { if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} } setPhase('idle'); }
      return;
    }

    var playbackToken = PLAYBACK.begin();
    setPhase('speaking');
    speakText(text, playbackToken).then(function () {
      if (!PLAYBACK.isCurrent(playbackToken)) return;
      clearExpectingReply();
      setPhase('idle');
      if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
      else if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
    }).catch(function (err) {
      if (!PLAYBACK.isCurrent(playbackToken)) return;
      console.error('[VA ' + vaTs() + '] [TTS] TTS failed:', err);
      clearExpectingReply();
      setPhase('idle');
      if (!CFG.autoListen && STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  TTS — with VAD pause + pipelined prefetch to prevent gaps
  // ═══════════════════════════════════════════════════════════════

  // Strip markdown/emoji noise, collapse whitespace, return clean prose.
  function cleanProse(text) {
    text = String(text || '');
    text = text.replace(/```[\s\S]*?```/g, ' [code block]. ');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/ thinking[\s\S]*?<\/think>/g, '');
    text = text.replace(/[*_#>|\[\]]/g, '');
    // Remove emoji before collapsed-punctuation handling
    text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
    text = text.replace(/\n{2,}/g, '. ');
    text = text.replace(/\n/g, ' ');
    text = text.replace(/\.\s+\.\s+/g, '. ');  // collapse ". ." from bold/list joins
    text = text.replace(/\.{2,}/g, '.');        // collapse ".." / "..." runs
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text;
  }

  // Split clean prose into sentences. Handles decimals (2.1) and common
  // abbreviations by requiring a space after the terminal punctuation.
  function splitIntoSentences(text) {
    var sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/g);
    if (sentences.length < 2) sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    return sentences.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }

  function chunkSentences(sentences, maxLen) {
    var chunks = [], current = '';
    for (var i = 0; i < sentences.length; i++) {
      if ((current + ' ' + sentences[i]).length > maxLen) {
        if (current) chunks.push(current.trim());
        current = sentences[i];
      } else { current += (current ? ' ' : '') + sentences[i]; }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }

  // Truncate: if truncateEnabled and the cleaned reply exceeds the budget,
  // keep the leading portion (up to a sentence boundary inside the budget) and
  // append a closure so it sounds intentional, not cut off. When disabled,
  // still returns cleaned prose (marks, emoji, whitespace stripped).
  function crispify(text) {
    var clean = cleanProse(text);
    if (!CFG.truncateEnabled || clean.length <= CFG.truncateChars) return clean;

    var sentences = splitIntoSentences(clean);
    var out = '';
    for (var i = 0; i < sentences.length; i++) {
      if (out.length + sentences[i].length + 1 > CFG.truncateChars) break;
      out += (out ? ' ' : '') + sentences[i];
    }
    if (!out) out = clean.slice(0, CFG.truncateChars);

    // End at a sentence boundary
    out = out.replace(/\s*[^.!?]*$/, '').trim();
    if (!/.*[.!?]$/.test(out)) out += '.';
    out += ' The full answer is on screen.';
    return out;
  }

  // Prefetch a chunk's audio while previously-fetched chunks are playing.
  // (Browser engine is handled separately in speakText via SpeechSynthesis.)
  function fetchAudioBlob(text) {
    var t0 = performance.now();
    if (CFG.ttsEngine === 'supertonic') {
      if (typeof window._hermesTtsIsRegistered !== 'function' || !window._hermesTtsIsRegistered('supertonic')) {
        return Promise.reject(new Error('Supertonic local engine is not loaded yet; reload the WebUI once'));
      }
      return Promise.resolve(window._hermesTtsSynth('supertonic', text, {
        voice: CFG.supertonicVoice,
        lang: CFG.supertonicLang,
        steps: CFG.supertonicSteps,
        speed: CFG.supertonicSpeed,
      })).then(function (buffer) {
        vaDbg('TTS-TIMING', 'Supertonic synth "' + text.slice(0, 30) + '" in ' + Math.round(performance.now() - t0) + 'ms');
        return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      });
    }
    var body = { text: text, engine: CFG.ttsEngine };
    // Send the engine-appropriate voice:
    //  - edge               → Edge neural voice name (server allowlist)
    //  - openai             → OpenAI voice name
    //  - elevenlabs         → ElevenLabs voice_id
    //  - supertonic-server  → local Supertonic style + synthesis controls
    var voice = CFG.ttsVoice;
    if (CFG.ttsEngine === 'openai') voice = CFG.openaiVoice;
    else if (CFG.ttsEngine === 'elevenlabs') voice = CFG.elevenlabsVoice;
    else if (CFG.ttsEngine === 'supertonic-server') {
      voice = CFG.supertonicVoice;
      body.lang = CFG.supertonicLang;
      body.steps = CFG.supertonicSteps;
      body.speed = CFG.supertonicSpeed;
    }
    if (voice) body.voice = voice;
    if (CFG.ttsRate) body.rate = CFG.ttsRate;
    var doFetch = function () {
      return fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    };
    var fetchPromise = typeof window.withVoiceRateLimitRetry === 'function'
      ? window.withVoiceRateLimitRetry(doFetch, 2100)
      : doFetch();
    return fetchPromise.then(function (resp) {
      if (!resp.ok) throw new Error('TTS HTTP ' + resp.status);
      return resp.blob();
    }).then(function (blob) {
      vaDbg('TTS-TIMING', '[' + CFG.ttsEngine + '] "' + text.slice(0, 30) + '" fetch → blob ' + blob.size + ' bytes in ' + Math.round(performance.now() - t0) + 'ms');
      return URL.createObjectURL(blob);
    });
  }

  function playAudioURL(url, playbackToken) {
    var pbT0 = performance.now();
    if (url === null) return Promise.resolve(true);
    if (!PLAYBACK.isCurrent(playbackToken)) {
      URL.revokeObjectURL(url);
      return Promise.resolve(false);
    }
    return new Promise(function (resolve, reject) {
      var audio = ensurePlaybackAudio();
      var settled = false;
      function cleanup() {
        audio.onended = null;
        audio.onerror = null;
        PLAYBACK.clearCancel(cancelPlayback);
        URL.revokeObjectURL(url);
      }
      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }
      function cancelPlayback() {
        try { audio.pause(); } catch (_) {}
        finish(false);
      }
      PLAYBACK.onCancel(cancelPlayback);
      audio.onplay = function () { vaDbg('AUDIO', 'Audio playback STARTED (enqueue-to-play ' + Math.round(performance.now() - pbT0) + 'ms)'); };
      audio.onended = function () {
        vaDbg('AUDIO', 'Audio playback ENDED (' + Math.round(performance.now() - pbT0) + 'ms since enqueue)');
        finish(true);
      };
      audio.onerror = function () {
        if (settled) return;
        settled = true;
        var mediaError = audio.error;
        cleanup();
        reject(new Error('Audio decode/playback failed' + (mediaError ? ' (code ' + mediaError.code + ')' : '')));
      };
      audio.muted = false;
      audio.src = url;
      audio.load();
      STATE.ttsAudio = audio;
      audio.play().catch(function (err) {
        if (settled) return;
        settled = true;
        cleanup();
        console.warn('[VA ' + vaTs() + '] [AUDIO] TTS play blocked:', err);
        showToast('Voice: Tap the microphone once to enable audio');
        reject(new Error('Browser blocked audio playback: ' + (err.message || err)));
      });
    });
  }

  async function speakText(text, playbackToken) {
    playbackToken = window.ensureVoicePlaybackToken(PLAYBACK, playbackToken);
    var prose = crispify(text);
    var sentences = splitIntoSentences(prose);
    var chunks = chunkSentences(sentences, CFG.ttsChunkSize);
    // Nothing speakable after cleaning (e.g. only markdown/emoji) — skip TTS
    // entirely rather than POSTing an empty body and getting 400.
    if (!chunks.length || !String(chunks[0] || '').trim()) {
      STATE.ttsActive = false;
      return;
    }
    STATE.ttsActive = true;

    // Keep neural VAD armed during TTS. Browser echo cancellation suppresses
    // most speaker leakage; genuine speech calls stopTTS() from onSpeechStart.
    if (CFG.ttsEngine === 'browser') {
      await speakBrowserChunks(chunks, playbackToken);
      if (!PLAYBACK.isCurrent(playbackToken)) return;
      STATE.ttsActive = false;
      return;
    }

    function guardedFetch(chunk) {
      return fetchAudioBlob(chunk).then(function (url) {
        if (!PLAYBACK.isCurrent(playbackToken)) {
          if (url) URL.revokeObjectURL(url);
          return null;
        }
        return url;
      });
    }

    var nextFetch = guardedFetch(chunks[0]);
    for (var i = 0; i < chunks.length; i++) {
      if (!STATE.ttsActive || !PLAYBACK.isCurrent(playbackToken)) break;
      STATE.ttsIndex = i;
      var url = await nextFetch;
      if (!url || !PLAYBACK.isCurrent(playbackToken)) break;
      nextFetch = (i + 1 < chunks.length) ? guardedFetch(chunks[i + 1]) : null;
      var completed = await playAudioURL(url, playbackToken);
      if (!completed) break;
    }

    if (!PLAYBACK.isCurrent(playbackToken)) return;
    STATE.ttsActive = false;
  }

  // Sequential browser-engine speech via SpeechSynthesis. A token promise
  // resolves when the last queued utterance ends, giving gapless queueing
  // that still respects stopTTS() (which calls speechSynthesis.cancel()).
  function speakBrowserChunks(chunks, playbackToken) {
    return new Promise(function (resolve) {
      if (!chunks.length) { resolve(); return; }
      if (!('speechSynthesis' in window)) { resolve(); return; }

      var finished = false;
      function done() {
        if (!finished) {
          finished = true;
          PLAYBACK.clearCancel(cancelBrowserSpeech);
          STATE.browserSpeechDone = true;
          resolve();
        }
      }
      function cancelBrowserSpeech() {
        try { window.speechSynthesis.cancel(); } catch (_) {}
        done();
      }
      PLAYBACK.onCancel(cancelBrowserSpeech);

      for (var i = 0; i < chunks.length; i++) {
        if (!STATE.ttsActive || !PLAYBACK.isCurrent(playbackToken)) { done(); return; }
        var utter = new SpeechSynthesisUtterance(chunks[i]);
        var voices = window.speechSynthesis.getVoices();
        if (CFG.ttsVoice && voices.length) {
          var wantLang = CFG.ttsVoice.split('-').slice(0, 2).join('-');
          var match = null;
          for (var v = 0; v < voices.length; v++) {
            if (voices[v].name === CFG.ttsVoice || voices[v].voiceURI.indexOf(CFG.ttsVoice) >= 0 || voices[v].lang === wantLang) { match = voices[v]; break; }
          }
          if (match) utter.voice = match;
          else if (voices.some(function (vv) { return vv.lang === wantLang; })) {
            utter.lang = wantLang;  // browser picks best available in this locale
          }
        }
        if (CFG.ttsRate) { var r = parseFloat(CFG.ttsRate); if (!isNaN(r) && r > -50) utter.rate = 1 + r / 100; }
        utter.onend = (i === chunks.length - 1) ? done : null;
        utter.onerror = (i === chunks.length - 1) ? done : null;
        window.speechSynthesis.speak(utter);
      }

      // Safety net: if the last utterance never fires onend (some browsers are
      // flaky with speechSynthesis), resolve after an estimated timeout based
      // on total text length (~15 chars/sec worst case).
      var estMs = Math.max(2000, Math.round(chunks.join(' ').length / 15 * 1000));
      setTimeout(done, estMs + 3000);
    });
  }

  function stopTTS() {
    PLAYBACK.cancel();
    STATE.ttsActive = false;
    if (STATE.ttsAudio) { try { STATE.ttsAudio.pause(); } catch (_) {} STATE.ttsAudio = null; }
    // Browser engine: cancel any queued SpeechSynthesis.
    if (CFG.ttsEngine === 'browser' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    // Note: VAD restart is handled by nextListen() / stopEverything() — this
    // only cuts audio playback so the two call sites stay consistent.
  }

  // ═══════════════════════════════════════════════════════════════
  //  Interaction
  // ═══════════════════════════════════════════════════════════════

  var orbSingleTimer = null;   // pending single-click action
  var DOUBLE_CLICK_MS = 300;   // window to detect a second click

  function onOrbClick(e) {
    // Must run synchronously inside the actual user gesture. The delayed
    // single-click action is too late for iOS autoplay permission.
    unlockMobileAudio();
    e.stopPropagation();

    // If a single-click action is already pending, this is a double-click →
    // cancel the pending action and open the settings panel instead.
    if (orbSingleTimer) {
      clearTimeout(orbSingleTimer);
      orbSingleTimer = null;
      if (panel) panel.classList.contains('va-open') ? closePanel() : openPanel();
      return;
    }

    // Schedule the single-click action — delayed so a second click can
    // upgrade it to a double-click (which opens settings) instead of
    // firing an action first.
    orbSingleTimer = setTimeout(function () {
      orbSingleTimer = null;
      handleSingleClick();
    }, DOUBLE_CLICK_MS);
  }

  // A single click toggles the assistant: start when idle, stop in any
  // active mode. In 'speaking' it also cuts current TTS.
  function handleSingleClick() {
    switch (STATE.phase) {
      case 'idle':
        startSession();
        break;
      case 'listening':
      case 'transcribing':
      case 'processing':
      case 'speaking':
        stopEverything();
        break;
    }
  }

  // Full stop: back to idle, kill VAD + TTS.
  function stopEverything() {
    vaDbg('CTRL', 'Stopping — back to idle (phase was ' + STATE.phase + ')');
    if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
    stopTTS();
    closeLiveSttCapture();
    STATE.stopGeneration += 1;
    STATE.openSpeechCaptures = 0;
    TURN.reset();
    resetStreamingResponse('', false);
    STATE.chunks = [];
    clearExpectingReply();
    setPhase('idle');
  }

  async function startSession() {
    showRipple();
    await nextListen();
  }

  async function nextListen() {
    if (STATE.phase === 'processing' || STATE.phase === 'transcribing' || STATE.phase === 'speaking') return;

    setPhase('listening');

    if (!STATE.vad) {
      showToast('Loading speech model…', 2000);
      var vad = await loadVAD();
      if (!vad) { setPhase('idle'); return; }
    }

    if (CFG.streamingSttEnabled) await ensureLiveSttCapture();

    STATE.responseDone = false;
    STATE.responseText = '';
    try { STATE.vad.start(); } catch (e) { console.warn('[VA] VAD start error:', e); }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Keyboard
  // ═══════════════════════════════════════════════════════════════

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'V') { e.preventDefault(); onOrbClick(e); }
    if (e.key === 'Escape' && STATE.phase !== 'idle') {
      stopEverything();
    }
  });

  // Resume audio context on first interaction (autoplay policy)
  document.addEventListener('click', function () { testWasmEval(); }, { once: false });

  // ═══════════════════════════════════════════════════════════════
  //  Boot
  // ═══════════════════════════════════════════════════════════════

  async function checkCapabilities() {
    try {
      var resp = await fetch('/api/transcribe/capability');
      if (resp.ok) {
        var data = await resp.json();
        if (!data.ok || !data.available) {
          if (orb) orb.style.opacity = '0.5';
          if (orb) orb.title = 'Voice Assistant (STT unavailable)';
        }
      }
    } catch (_) {}
  }

  async function init() {
    loadSettings();
    injectUI();
    ensurePlaybackAudio();
    // Capture phase runs even when the orb stops event propagation.
    document.addEventListener('pointerdown', unlockMobileAudio, { capture: true, passive: true });
    document.addEventListener('touchend', unlockMobileAudio, { capture: true, passive: true });
    setPhase('idle');
    hookSSE();
    checkCapabilities();
    testWasmEval();
    vaDbg('BOOT', 'Voice Assistant v4.3.3 loaded — live STT + streaming TTS + barge-in | cfg=' + JSON.stringify({
      stt: CFG.streamingSttEnabled, tts: CFG.ttsEngine, voice: CFG.ttsVoice,
      crisp: CFG.crispPrompt, truncate: CFG.truncateEnabled, autoListen: CFG.autoListen,
    }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1200); });
  } else {
    setTimeout(init, 1200);
  }

})();
