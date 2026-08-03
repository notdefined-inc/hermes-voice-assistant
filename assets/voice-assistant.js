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
    ttsEngine: 'edge',
    ttsRate: '',
    ttsChunkSize: 500,

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

      STATE.vad = await MicVAD.new({
        stream: STATE.audioStream,   // use OUR stream — library never calls getUserMedia
        positiveSpeechThreshold: CFG.positiveSpeechThreshold,
        negativeSpeechThreshold: CFG.negativeSpeechThreshold,
        minSpeechFrames: CFG.minSpeechFrames,
        preSpeechPadFrames: CFG.preSpeechPadFrames,
        redemptionFrames: CFG.redemptionFrames,
        onSpeechStart: function () {
          console.log('[VA] Speech start');
          beginRecording();
        },
        onSpeechEnd: function () {
          console.log('[VA] Speech end');
          finishRecording();
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
  //  Recording (engine-agnostic, uses stream from Silero VAD)
  // ═══════════════════════════════════════════════════════════════

  function getMicStream() {
    // We procured the stream ourselves in loadVAD() and own it directly.
    return STATE.audioStream;
  }

  function beginRecording() {
    if (STATE.phase !== 'listening') return;
    var stream = getMicStream();
    if (!stream) return;

    STATE.chunks = [];
    var mimeType = 'audio/webm;codecs=opus';
    if (typeof MediaRecorder !== 'undefined' && !MediaRecorder.isTypeSupported(mimeType)) { mimeType = 'audio/webm'; if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = ''; }

    try {
      STATE.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
    } catch (e) { console.error('[VA] MediaRecorder init failed:', e); return; }

    STATE.mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) STATE.chunks.push(e.data); };
    STATE.mediaRecorder.start(200);
  }

  function finishRecording() {
    if (!STATE.mediaRecorder || STATE.mediaRecorder.state !== 'recording') {
      // VAD ended but recorder wasn't running — reset
      resetSileroMic();
      return;
    }

    STATE.mediaRecorder.onstop = function () {
      var blob = new Blob(STATE.chunks, { type: STATE.mediaRecorder.mimeType || 'audio/webm' });
      STATE.mediaRecorder = null;
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
    };

    try { STATE.mediaRecorder.stop(); } catch (_) {}
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
    var ext = blob.type.includes('webm') ? '.webm' : '.ogg';
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

  function stopTTS() {
    STATE.ttsActive = false;
    if (STATE.ttsAudio) { try { STATE.ttsAudio.pause(); } catch (_) {} STATE.ttsAudio = null; }
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

  // Full stop: back to idle, kill VAD + recorder + TTS.
  function stopEverything() {
    console.log('[VA] Stopping — back to idle');
    if (STATE.vad) { try { STATE.vad.pause(); } catch (_) {} }

    if (STATE.mediaRecorder && STATE.mediaRecorder.state === 'recording') {
      STATE.chunks = [];
      STATE.mediaRecorder.onstop = null;
      try { STATE.mediaRecorder.stop(); } catch (_) {}
      STATE.mediaRecorder = null;
    }

    stopTTS();
    // Drop the pending audio context so nothing keeps the mic warm
    setTimeout(function () {
      if (STATE.phase === 'idle') setPhase('idle');
    }, 50);
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
