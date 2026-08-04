(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.ElevenLabsLiveSession = api.ElevenLabsLiveSession;
    root.elevenLabsBytesToBase64 = api.elevenLabsBytesToBase64;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Reuse the pipeline's timestamped logger when present (browser), else a
  // silent no-op so Node unit tests never emit console noise.
  function dbg(tag, msg) {
    if (typeof window !== 'undefined' && typeof window.vaDbg === 'function') {
      window.vaDbg('EL-' + tag, msg);
    }
  }
  var STT_T0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  function elapsed() {
    return Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - STT_T0);
  }

  // How long finish() waits for the server's committed_transcript after the
  // final commit message. ElevenLabs Realtime is fast (150 ms class), but the
  // network + model settle can stretch; 15 s is generous. The caller's outer
  // withVoiceTimeout(45 s) still bounds the worst case.
  var FINISH_TIMEOUT_MS = 15000;

  var WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
  var MODEL_ID = 'scribe_v2_realtime';

  function toBytes(value) {
    if (!value) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(value);
  }

  function concatBytes(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].byteLength;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], offset);
      offset += parts[j].byteLength;
    }
    return out;
  }

  // Chunked binary → base64 (avoids call-stack overflow on large buffers).
  function elevenLabsBytesToBase64(bytes) {
    bytes = toBytes(bytes);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    if (typeof btoa === 'function') return btoa(bin);
    if (typeof Buffer !== 'undefined') return Buffer.from(bin, 'binary').toString('base64');
    return '';
  }

  // Minimal pre-roll ring (same contract as PcmRingBuffer in live-stt-client.js)
  // so the extension's carry-over logic (ring.parts / ring.bytes) keeps working
  // even when live-stt-client.js is not loaded.
  function PcmRingBuffer(maxBytes) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.parts = [];
    this.bytes = 0;
  }
  PcmRingBuffer.prototype.push = function (value) {
    var part = toBytes(value).slice();
    if (!part.byteLength || !this.maxBytes) return;
    this.parts.push(part);
    this.bytes += part.byteLength;
    while (this.bytes > this.maxBytes && this.parts.length) {
      var overflow = this.bytes - this.maxBytes;
      var first = this.parts[0];
      if (overflow >= first.byteLength) {
        this.parts.shift();
        this.bytes -= first.byteLength;
      } else {
        this.parts[0] = first.slice(overflow);
        this.bytes -= overflow;
      }
    }
  };
  PcmRingBuffer.prototype.drain = function () {
    var out = concatBytes(this.parts);
    this.parts = [];
    this.bytes = 0;
    return out;
  };

  function ElevenLabsLiveSession(options) {
    options = options || {};
    this.WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.tokenUrl = String(options.tokenUrl || '/api/stt/elevenlabs-token');
    this.modelId = options.modelId || MODEL_ID;
    // '' = auto-detect; else ISO 639-1/3 (en, hi, ur, ...)
    this.language = String(options.language || '').trim();
    this.onTranscript = options.onTranscript || function () {};
    this.onReady = options.onReady || function () {};
    this.onError = options.onError || function () {};
    this.ring = options.ring || (options.preRollBytes ? new PcmRingBuffer(options.preRollBytes) : new PcmRingBuffer(32000));
    this.socket = null;
    this.active = false;
    this.finishing = false;
    this.pending = [];           // PCM chunks awaiting WS open
    this.lastTranscript = '';
    this.confirmedViaReadyStop = false; // committed_transcript received
    this._connectPromise = null;
    this._finishResolve = null;
    this._finishTimeout = null;
    this._t0 = elapsed();
  }

  ElevenLabsLiveSession.prototype._fetchToken = function () {
    var self = this;
    return fetch(self.tokenUrl, { method: 'POST', headers: { 'Accept': 'application/json' } })
      .then(function (resp) {
        if (!resp.ok) throw new Error('token HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        var token = data && (data.token || data.tokens) || '';
        if (!token) throw new Error('no token in response');
        return token;
      });
  };

  ElevenLabsLiveSession.prototype._sendChunk = function (pcmBytes, commit) {
    if (!this.socket || this.socket.readyState !== 1) return;
    var msg = {
      message_type: 'input_audio_chunk',
      audio_base_64: elevenLabsBytesToBase64(pcmBytes),
      commit: !!commit,
      sample_rate: 16000,
    };
    try { this.socket.send(JSON.stringify(msg)); } catch (_) {}
  };

  ElevenLabsLiveSession.prototype.pushPcm = function (value) {
    var bytes = toBytes(value).slice();
    if (!bytes.byteLength) return;
    if (!this.active) {
      this.ring.push(bytes);
      return;
    }
    if (this.socket && this.socket.readyState === 1) this._sendChunk(bytes, false);
    else this.pending.push(bytes);
  };

  ElevenLabsLiveSession.prototype._connect = function (token) {
    if (!this.WebSocketImpl) {
      this.onError(new Error('ElevenLabs live STT WebSocket unavailable'));
      return null;
    }
    var q = '?model_id=' + encodeURIComponent(this.modelId) +
      '&token=' + encodeURIComponent(token) +
      '&audio_format=pcm_16000' +
      '&commit_strategy=manual';
    if (this.language) q += '&language_code=' + encodeURIComponent(this.language);
    var ws = new this.WebSocketImpl(WS_BASE + q);
    this.socket = ws;

    var self = this;
    ws.onopen = function () {
      if (self.socket !== ws || !self.active) return;
      dbg('WS', 'open (+' + (elapsed() - self._t0) + 'ms); flushing ' + self.pending.length + ' pending chunk(s)');
      while (self.pending.length) self._sendChunk(self.pending.shift(), false);
      if (self.finishing) self._sendChunk(new Uint8Array(0), true);
    };
    ws.onmessage = function (event) {
      if (self.socket !== ws) return;
      var msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || !msg.message_type) return;

      switch (msg.message_type) {
        case 'session_started':
          dbg('WS', 'session_started (+' + (elapsed() - self._t0) + 'ms)');
          return;
        case 'partial_transcript':
          if (msg.text && msg.text !== self.lastTranscript) {
            self.lastTranscript = msg.text;
            dbg('TX', 'partial "' + msg.text.slice(0, 60) + '" (+' + (elapsed() - self._t0) + 'ms)');
            self.onTranscript(msg.text, msg);
          }
          return;
        case 'final_transcript':
          // Final result for a segment once speech has settled (manual mode
          // still emits this before commit). Treat as partial display text.
          if (msg.text && msg.text !== self.lastTranscript) {
            self.lastTranscript = msg.text;
            self.onTranscript(msg.text, msg);
          }
          return;
        case 'committed_transcript':
          // AUTHORITATIVE final text for the committed segment.
          dbg('WS', 'committed_transcript (+' + (elapsed() - self._t0) + 'ms) text="' + String(msg.text || '').slice(0, 60) + '"');
          if (msg.text && msg.text.length >= self.lastTranscript.length) {
            self.lastTranscript = msg.text;
          }
          self.confirmedViaReadyStop = true;
          if (self._finishResolve) {
            var resolve = self._finishResolve;
            self._finishResolve = null;
            if (self._finishTimeout) { clearTimeout(self._finishTimeout); self._finishTimeout = null; }
            resolve(self.lastTranscript);
          }
          self.onReady(self.lastTranscript);
          self.close();
          return;
        case 'error':
        case 'auth_error':
        case 'input_error':
        case 'rate_limited':
        case 'quota_exceeded':
        case 'commit_throttled':
          dbg('WS-ERR', msg.message_type + ': ' + String(msg.error || ''));
          self.onError(new Error(msg.message_type + ': ' + String(msg.error || 'unknown')));
          return;
        default:
          return;
      }
    };
    ws.onerror = function () {
      if (self.socket === ws) {
        dbg('WS-ERR', 'connection error (+' + (elapsed() - self._t0) + 'ms)');
        self.onError(new Error('ElevenLabs live STT connection failed'));
      }
    };
    return ws;
  };

  ElevenLabsLiveSession.prototype.start = function (preRoll) {
    if (!this.WebSocketImpl || !this.tokenUrl) {
      this.onError(new Error('ElevenLabs live STT unavailable'));
      return false;
    }
    this.close();
    this.active = true;
    this.finishing = false;
    this.lastTranscript = '';
    this.confirmedViaReadyStop = false;
    this._finishResolve = null;
    this._finishTimeout = null;
    this._t0 = elapsed();

    var initial = this.ring.drain();
    var explicit = toBytes(preRoll);
    this.pending = [];
    if (initial.byteLength || explicit.byteLength) this.pending.push(concatBytes([initial, explicit]));

    var self = this;
    this._connectPromise = this._fetchToken().then(function (token) {
      dbg('WS', 'token fetched (+' + (elapsed() - self._t0) + 'ms); connecting');
      self._connect(token);
      return token;
    }).catch(function (err) {
      dbg('WS-ERR', 'token fetch failed: ' + String(err && err.message || err));
      self.onError(new Error('ElevenLabs token fetch failed: ' + String(err && err.message || err)));
      self.active = false;
    });
    return true;
  };

  ElevenLabsLiveSession.prototype.finish = function () {
    if (!this.active) return Promise.resolve(this.lastTranscript);
    if (this.finishing) return Promise.resolve(this.lastTranscript);
    this.finishing = true;
    var self = this;
    return new Promise(function (resolve) {
      self._finishResolve = resolve;
      self._finishTimeout = setTimeout(function () {
        if (self._finishResolve === resolve) {
          self._finishResolve = null;
          self._finishTimeout = null;
          dbg('WS-TIMEOUT', 'finish TIMED OUT after ' + FINISH_TIMEOUT_MS + 'ms — resolving with lastTranscript="' + String(self.lastTranscript).slice(0, 60) + '"');
          resolve(self.lastTranscript);
        }
      }, FINISH_TIMEOUT_MS);

      var commit = function () {
        if (self.socket && self.socket.readyState === 1) {
          self._sendChunk(new Uint8Array(0), true);
        }
      };
      if (self.socket && (self.socket.readyState === 1 || self.socket.readyState === 0)) {
        commit();
      } else if (self._connectPromise) {
        self._connectPromise.then(commit);
      }
    });
  };

  ElevenLabsLiveSession.prototype.close = function () {
    var ws = this.socket;
    if (this._finishResolve) {
      var resolve = this._finishResolve;
      this._finishResolve = null;
      if (this._finishTimeout) { clearTimeout(this._finishTimeout); this._finishTimeout = null; }
      dbg('WS', 'close: resolving finish with lastTranscript="' + String(this.lastTranscript).slice(0, 60) + '"');
      resolve(this.lastTranscript);
    }
    this.socket = null;
    this.active = false;
    this.finishing = false;
    this.pending = [];
    if (ws && ws.readyState < 2 && typeof ws.close === 'function') {
      try { ws.close(); } catch (_) {}
    }
  };

  return {
    ElevenLabsLiveSession: ElevenLabsLiveSession,
    elevenLabsBytesToBase64: elevenLabsBytesToBase64,
  };
});
