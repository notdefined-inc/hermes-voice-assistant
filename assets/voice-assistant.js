/**
 * Voice Assistant Extension v3.0 for Hermes WebUI
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
 */

(function () {
  'use strict';

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

    ttsEnabled: true,
    ttsVoice: 'en-GB-SoniaNeural',
    ttsEngine: 'edge',       // edge (default, no key) | openai | elevenlabs | browser
    ttsRate: '',
    ttsChunkSize: 500,

    // Speech detection (Silero VAD) — configurable timing. All in milliseconds.
    // preRollMs = audio buffered before speech is confirmed (fixes cut-off starts)
    // minSpeechMs = how long speech must persist before being accepted (misfire guard)
    // endSilenceMs = trailing silence that ends the utterance
    preRollMs: 300,
    minSpeechMs: 400,
    endSilenceMs: 650,

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
    ttsActive: false,
    responseDone: false,
    responseText: '',
    evalWasmTested: false,
    panelOpen: false,
    sseHooked: false,
  };

  var LS_KEY = 'va-settings-v3';

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

      // Migrate v3.1 "speechBudgetChars" → v3.3 truncate {
      if (typeof s.speechBudgetChars === 'number' && s.speechBudgetChars > 0) {
        CFG.truncateEnabled = true;
        CFG.truncateChars = s.speechBudgetChars;
      }
      // } end migration
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
      '<div class="va-setting-row"><div><label>Sensitivity</label><div class="va-hint">← Less sensitive · More →</div></div>',
      '<div class="va-slider-row"><input type="range" min="1" max="10" value="' + sensVal + '" id="va-sens-slider">',
      '<span class="va-slider-val" id="va-sens-val">' + sensVal + '</span></div></div>',
      '<div class="va-setting-row"><div><label>TTS Voice</label></div>',
      '<select id="va-voice-select"><option value="">Default</option>',
        '<option value="en-US-JennyNeural"' + (CFG.ttsVoice === 'en-US-JennyNeural' ? ' selected' : '') + '>Jenny (US)</option>',
        '<option value="en-US-GuyNeural"' + (CFG.ttsVoice === 'en-US-GuyNeural' ? ' selected' : '') + '>Guy (US)</option>',
        '<option value="en-GB-SoniaNeural"' + (CFG.ttsVoice === 'en-GB-SoniaNeural' ? ' selected' : '') + '>Sonia (UK)</option>',
        '<option value="en-GB-RyanNeural"' + (CFG.ttsVoice === 'en-GB-RyanNeural' ? ' selected' : '') + '>Ryan (UK)</option>',
      '</select></div>',
      '<div class="va-setting-row"><div><label>TTS Engine</label><div class="va-hint">Edge = free, no key. Others need a server API key</div></div>',
      '<select id="va-engine-select">',
        '<option value="edge"' + (CFG.ttsEngine === 'edge' ? ' selected' : '') + '>Edge (free)</option>',
        '<option value="openai"' + (CFG.ttsEngine === 'openai' ? ' selected' : '') + '>OpenAI</option>',
        '<option value="elevenlabs"' + (CFG.ttsEngine === 'elevenlabs' ? ' selected' : '') + '>ElevenLabs</option>',
        '<option value="browser"' + (CFG.ttsEngine === 'browser' ? ' selected' : '') + '>Browser (client)</option>',
      '</select></div>',
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
      '<div style="font-size:11px;opacity:0.4;margin-top:12px;text-align:center;">v3.3 · Silero VAD · SSE Hook · Pipelined TTS · Double-click for settings</div>',
    ].join('');
  }

  function wirePanel() {
    function bindToggle(id, key) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function () { CFG[key] = !CFG[key]; el.classList.toggle('va-on', CFG[key]); saveSettings(); });
    }
    bindToggle('va-tts-toggle', 'ttsEnabled');
    bindToggle('va-auto-toggle', 'autoListen');

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

    var voice = document.getElementById('va-voice-select');
    if (voice) voice.addEventListener('change', function () { CFG.ttsVoice = voice.value; saveSettings(); });

    // TTS Engine selector.
    var engine = document.getElementById('va-engine-select');
    if (engine) engine.addEventListener('change', function () { CFG.ttsEngine = engine.value; saveSettings(); });

    // VAD timing sliders — dynamic-range maps ms → frames at init/update time.
    bindRange('va-preroll-slider', 'va-preroll-val', 'preRollMs', 0, 900, 'ms');
    bindRange('va-minspeech-slider', 'va-minspeech-val', 'minSpeechMs', 100, 1200, 'ms');
    bindRange('va-endsil-slider', 'va-endsil-val', 'endSilenceMs', 200, 2000, 'ms');
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
        statusLabel.textContent = 'Listening…'; statusLabel.classList.add('va-visible'); break;
      case 'transcribing':
        orb.innerHTML = '⏳'; orb.classList.add('va-processing');
        statusLabel.textContent = 'Transcribing…'; statusLabel.classList.add('va-visible'); break;
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

      es.addEventListener('done', function (e) {
        console.log('[VA] SSE done event received');
        try {
          var data = JSON.parse(e.data);
          var msgs = (data.session && data.session.messages) || [];
          var lastAsst = null;
          for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') { lastAsst = msgs[i]; break; }
          }
          var text = lastAsst ? (lastAsst.content || '').trim() : '';
          text = text.replace(/ thinking[\s\S]*?<\/think>/g, '').trim();

          STATE.responseDone = true;
          STATE.responseText = text;

          if (STATE.phase === 'processing') {
            onAgentResponseComplete(text);
          }
        } catch (err) {
          console.warn('[VA] SSE done parse error, triggering anyway:', err);
          STATE.responseDone = true;
          if (STATE.phase === 'processing') onAgentResponseComplete('');
        }
      });

      return es;
    }
    PatchedES.prototype = OrigES.prototype;
    PatchedES.CONNECTING = OrigES.CONNECTING;
    PatchedES.OPEN = OrigES.OPEN;
    PatchedES.CLOSED = OrigES.CLOSED;
    window.EventSource = PatchedES;

    console.log('[VA] EventSource hooked for response detection');
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

  async function loadVAD() {
    if (STATE.vad) return STATE.vad;

    var wasmOk = await testWasmEval();
    if (!wasmOk) {
      console.error('[VA] WebAssembly blocked by CSP — Silero VAD cannot run');
      showToast('Voice: WASM blocked by security policy');
      return null;
    }

    // Critical: procure the mic stream OURSELVES and pass it into Silero.
    // In non-secure contexts (plain HTTP on a non-localhost address) the
    // browser does not expose navigator.mediaDevices — Silero's internal
    // getUserMedia would crash with "reading 'getUserMedia' of undefined".
    if (!STATE.audioStream) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        console.error('[VA] navigator.mediaDevices unavailable — requires localhost or HTTPS');
        showToast('Voice: Mic needs localhost or HTTPS connection');
        return null;
      }
      try {
        STATE.audioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        console.error('[VA] getUserMedia denied:', e);
        showToast('Voice: Microphone access denied');
        return null;
      }
    }

    try {
      var mod = await import(VAD_CDN);
      var MicVAD = mod.MicVAD;

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
          console.log('[VA] Speech start');
          setPhase('listening'); // stay armed; buffer is owned by Silero
        },
        onSpeechEnd: function (audio) {
          console.log('[VA] Speech end (%d samples)', audio ? audio.length : 0);
          // Silero hands us the full utterance INCLUDING pre-roll padding —
          // encode to WAV ourselves; never use MediaRecorder (it starts too
          // late and loses the first ~200-400ms of speech).
          finishWithAudio(audio);
        },
        onVADMisfire: function () {
          console.log('[VA] VAD misfire — too short');
          resetSileroMic();
        },
      });

      console.log('[VA] Silero VAD initialized');
      return STATE.vad;
    } catch (e) {
      console.error('[VA] Silero VAD init failed:', e);
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
  function finishWithAudio(audio) {
    if (!audio || !audio.length) { resetSileroMic(); return; }

    // Guard: require the utterance to actually contain speech energy, else
    // the "silence/misfire → instant transcribe" loop would spam the STT.
    var peak = 0;
    for (var i = 0; i < audio.length; i += 40) {
      var a = Math.abs(audio[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.002) {  // effectively silent clip
      console.log('[VA] utterance too quiet, ignoring');
      resetSileroMic();
      return;
    }

    var blob = encodeWav(audio);
    if (blob.size < 1500) { resetSileroMic(); return; }

    setPhase('transcribing');
    transcribeAudio(blob).then(function (text) {
      if (text && text.trim().length > 0) {
        sendToAgent(text.trim());
      } else {
        resetSileroMic();
      }
    }).catch(function (err) {
      console.error('[VA] Transcribe failed:', err);
      showToast('Voice: Transcription failed');
      resetSileroMic();
    });
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

  function sendToAgent(text) {
    setPhase('processing');
    STATE.responseDone = false;
    STATE.responseText = '';

    var textarea = document.getElementById('msg');
    if (!textarea) { console.error('[VA] No #msg textarea'); resetSileroMic(); return; }

    // Crisp Replies: append a directive so the AGENT answers short & direct.
    var outText = text;
    if (CFG.crispPrompt && CFG.crispDirective) {
      outText = text + '\n\n(Instruction: ' + CFG.crispDirective + ')';
    }

    textarea.value = outText;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(function () {
      if (typeof send === 'function') send();
      else {
        var evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        textarea.dispatchEvent(evt);
      }

      // Watchdog: if SSE done doesn't fire in 3 min, recover
      setTimeout(function () {
        if (STATE.phase === 'processing' && !STATE.responseDone) {
          console.warn('[VA] Watchdog: SSE done not received in 3 min, recovering');
          setPhase('idle');
        }
      }, 180000);
    }, 100);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Response Complete → TTS
  // ═══════════════════════════════════════════════════════════════

  function onAgentResponseComplete(text) {
    if (!CFG.ttsEnabled || !text.trim()) {
      if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
      else setPhase('idle');
      return;
    }

    setPhase('speaking');
    speakText(text).then(function () {
      setPhase('idle');
      if (CFG.autoListen) setTimeout(nextListen, CFG.autoListenDelay);
    }).catch(function (err) {
      console.error('[VA] TTS failed:', err);
      setPhase('idle');
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
    var body = { text: text, engine: CFG.ttsEngine };
    if (CFG.ttsVoice) body.voice = CFG.ttsVoice;
    if (CFG.ttsRate) body.rate = CFG.ttsRate;
    return fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(function (resp) {
      if (!resp.ok) throw new Error('TTS HTTP ' + resp.status);
      return resp.blob();
    }).then(function (blob) {
      return URL.createObjectURL(blob);
    });
  }

  function playAudioURL(url) {
    // Browser engine already spoke via SpeechSynthesis — nothing to play here.
    if (url === null) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var audio = new Audio(url);
      audio.setAttribute('playsinline', '');
      audio.onended = function () { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = function () { URL.revokeObjectURL(url); resolve(); };
      STATE.ttsAudio = audio;
      audio.play().catch(function (err) {
        URL.revokeObjectURL(url);
        console.warn('[VA] TTS play blocked:', err);
        resolve();
      });
    });
  }

  async function speakText(text) {
    var prose = crispify(text);
    var sentences = splitIntoSentences(prose);
    var chunks = chunkSentences(sentences, CFG.ttsChunkSize);
    STATE.ttsActive = true;

    // Pause VAD during playback — no speech detection while speaking
    if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }

    // Browser engine: SpeechSynthesis queues utterances natively and calls us
    // back when each ends, so we speak sequentially and wait for the last one.
    if (CFG.ttsEngine === 'browser') {
      await speakBrowserChunks(chunks);
      STATE.ttsActive = false;
      await new Promise(function (r) { setTimeout(r, 400); });
      return;
    }

    // Pipeline: pre-fetch the next blob while the current one plays, so the
    // Edge TTS latency (~1-3s) is hidden behind playback — no punctuation gaps.
    var nextFetch = fetchAudioBlob(chunks[0]);
    for (var i = 0; i < chunks.length; i++) {
      if (!STATE.ttsActive) break;
      STATE.ttsIndex = i;
      var url = await nextFetch;
      nextFetch = (i + 1 < chunks.length) ? fetchAudioBlob(chunks[i + 1]) : null;
      await playAudioURL(url);
    }

    STATE.ttsActive = false;

    // Cooldown for speaker echo decay
    await new Promise(function (r) { setTimeout(r, 400); });
  }

  // Sequential browser-engine speech via SpeechSynthesis. A token promise
  // resolves when the last queued utterance ends, giving gapless queueing
  // that still respects stopTTS() (which calls speechSynthesis.cancel()).
  function speakBrowserChunks(chunks) {
    return new Promise(function (resolve) {
      if (!chunks.length) { resolve(); return; }
      if (!('speechSynthesis' in window)) { resolve(); return; }

      var finished = false;
      function done() { if (!finished) { finished = true; STATE.browserSpeechDone = true; resolve(); } }

      for (var i = 0; i < chunks.length; i++) {
        if (!STATE.ttsActive) { done(); return; }
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
    console.log('[VA] Stopping — back to idle');
    if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }
    stopTTS();
    STATE.chunks = [];
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

  function init() {
    loadSettings();
    injectUI();
    setPhase('idle');
    hookSSE();
    checkCapabilities();
    testWasmEval();
    console.log('[VA] Voice Assistant v3.0 loaded — Silero VAD + SSE hook + TTS');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1200); });
  } else {
    setTimeout(init, 1200);
  }

})();
