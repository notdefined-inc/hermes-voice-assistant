(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.PcmRingBuffer = api.PcmRingBuffer;
    root.LiveSttSession = api.LiveSttSession;
    root.StreamingPcm16Encoder = api.StreamingPcm16Encoder;
    root.transcriptFromWlkMessage = api.transcriptFromWlkMessage;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

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
  PcmRingBuffer.prototype.clear = function () {
    this.parts = [];
    this.bytes = 0;
  };

  function transcriptFromWlkMessage(msg) {
    if (!msg || typeof msg !== 'object') return '';
    var parts = [];
    var lines = Array.isArray(msg.lines) ? msg.lines : [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i] || {};
      if (line.speaker === -2 || !line.text) continue;
      var text = String(line.text).trim();
      if (text) parts.push(text);
    }
    var partial = String(msg.buffer_transcription || '').trim();
    if (partial) parts.push(partial);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function StreamingPcm16Encoder(inputRate, outputRate) {
    this.inputRate = Math.max(1, Number(inputRate) || 48000);
    this.outputRate = Math.max(1, Number(outputRate) || 16000);
    this.ratio = this.inputRate / this.outputRate;
    this.buffer = new Float32Array(0);
    this.offset = 0;
  }
  StreamingPcm16Encoder.prototype.encode = function (input) {
    input = input instanceof Float32Array ? input : new Float32Array(input || 0);
    var merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer, 0);
    merged.set(input, this.buffer.length);
    var values = [];
    while (this.offset + this.ratio <= merged.length) {
      var begin = Math.floor(this.offset);
      var end = Math.max(begin + 1, Math.floor(this.offset + this.ratio));
      var sum = 0;
      for (var i = begin; i < end && i < merged.length; i++) sum += merged[i];
      values.push(sum / Math.max(1, end - begin));
      this.offset += this.ratio;
    }
    var consumed = Math.floor(this.offset);
    this.buffer = merged.slice(consumed);
    this.offset -= consumed;
    var out = new Uint8Array(values.length * 2);
    var view = new DataView(out.buffer);
    for (var j = 0; j < values.length; j++) {
      var sample = Math.max(-1, Math.min(1, values[j]));
      view.setInt16(j * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return out;
  };

  function LiveSttSession(options) {
    options = options || {};
    this.WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.url = String(options.url || '');
    this.onTranscript = options.onTranscript || function () {};
    this.onReady = options.onReady || function () {};
    this.onError = options.onError || function () {};
    this.ring = new PcmRingBuffer(options.preRollBytes || 32000);
    this.socket = null;
    this.active = false;
    this.finishing = false;
    this.pending = [];
    this.lastTranscript = '';
  }

  LiveSttSession.prototype.pushPcm = function (value) {
    var bytes = toBytes(value).slice();
    if (!bytes.byteLength) return;
    if (!this.active) {
      this.ring.push(bytes);
      return;
    }
    if (this.socket && this.socket.readyState === 1) this.socket.send(bytes);
    else this.pending.push(bytes);
  };

  LiveSttSession.prototype.start = function (preRoll) {
    if (!this.WebSocketImpl || !this.url) {
      this.onError(new Error('live STT WebSocket unavailable'));
      return false;
    }
    this.close();
    this.active = true;
    this.finishing = false;
    this.lastTranscript = '';
    this._finishResolve = null;
    this._finishTimeout = null;
    var initial = this.ring.drain();
    var explicit = toBytes(preRoll);
    this.pending = [];
    if (initial.byteLength || explicit.byteLength) this.pending.push(concatBytes([initial, explicit]));

    var self = this;
    var ws = new this.WebSocketImpl(this.url);
    this.socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      if (self.socket !== ws || !self.active) return;
      while (self.pending.length) ws.send(self.pending.shift());
      if (self.finishing) ws.send(new Uint8Array(0));
    };
    ws.onmessage = function (event) {
      if (self.socket !== ws) return;
      try {
        var msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg && msg.type === 'ready_to_stop') {
          // The ready_to_stop message may carry the final flushed transcript
          // (lines + buffer_transcription). Parse it before resolving.
          var finalText = transcriptFromWlkMessage(msg);
          if (finalText && finalText.length > self.lastTranscript.length) {
            self.lastTranscript = finalText;
          }
          if (self._finishResolve) {
            var resolve = self._finishResolve;
            self._finishResolve = null;
            if (self._finishTimeout) { clearTimeout(self._finishTimeout); self._finishTimeout = null; }
            resolve(self.lastTranscript);
          }
          self.onReady(self.lastTranscript);
          self.close();
          return;
        }
        if (msg && msg.type === 'config') return;
        var text = transcriptFromWlkMessage(msg);
        if (text && text !== self.lastTranscript) {
          self.lastTranscript = text;
          self.onTranscript(text, msg);
        }
      } catch (err) {
        self.onError(err);
      }
    };
    ws.onerror = function () {
      if (self.socket === ws) self.onError(new Error('live STT connection failed'));
    };
    return true;
  };

  LiveSttSession.prototype.finish = function () {
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
          resolve(self.lastTranscript);
        }
      }, 3000);
      if (self.socket && self.socket.readyState === 1) self.socket.send(new Uint8Array(0));
    });
  };

  LiveSttSession.prototype.close = function () {
    var ws = this.socket;
    // Resolve any pending finish() promise before tearing down,
    // otherwise the caller's await hangs until the outer timeout.
    if (this._finishResolve) {
      var resolve = this._finishResolve;
      this._finishResolve = null;
      if (this._finishTimeout) { clearTimeout(this._finishTimeout); this._finishTimeout = null; }
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
    PcmRingBuffer: PcmRingBuffer,
    LiveSttSession: LiveSttSession,
    StreamingPcm16Encoder: StreamingPcm16Encoder,
    transcriptFromWlkMessage: transcriptFromWlkMessage,
  };
});
