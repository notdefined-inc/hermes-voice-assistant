(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.ensureVoicePlaybackToken = api.ensurePlaybackToken;
    root.voicePhaseAfterStt = api.phaseAfterStt;
    root.withVoiceTimeout = api.withTimeout;
    root.withVoiceRateLimitRetry = api.withRateLimitRetry;
    root.IncrementalVoiceSentenceBuffer = api.IncrementalSentenceBuffer;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function ensurePlaybackToken(playback, token) {
    if (!playback || typeof playback.begin !== 'function' || typeof playback.isCurrent !== 'function') {
      throw new TypeError('A playback generation controller is required');
    }
    return token !== undefined && token !== null && playback.isCurrent(token)
      ? token
      : playback.begin();
  }

  function phaseAfterStt(state) {
    state = state || {};
    if (state.ttsActive) return 'speaking';
    if (Number(state.pendingStt || 0) > 0) return 'transcribing';
    if (state.expectingReply) return 'processing';
    return 'listening';
  }

  function withTimeout(task, timeoutMs, timers) {
    timers = timers || { setTimeout: function () { return setTimeout.apply(null, arguments); }, clearTimeout: function () { return clearTimeout.apply(null, arguments); } };
    var timer = null;
    return new Promise(function (resolve, reject) {
      timer = timers.setTimeout(function () {
        reject(new Error('Voice operation timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      Promise.resolve().then(task).then(resolve, reject);
    }).finally(function () {
      if (timer !== null) timers.clearTimeout(timer);
    });
  }

  function withRateLimitRetry(task, delayMs, timers) {
    timers = timers || { setTimeout: function () { return setTimeout.apply(null, arguments); } };
    return Promise.resolve().then(task).then(function (result) {
      if (!result || result.status !== 429) return result;
      return new Promise(function (resolve) {
        timers.setTimeout(resolve, delayMs || 2100);
      }).then(task);
    });
  }

  // ── Sentence segmentation utilities ──────────────────────────────────
  //
  // The streaming pipeline must split incoming text deltas into complete
  // sentences for incremental TTS. Two strategies are used:
  //
  //   1. Intl.Segmenter (preferred) — ICU-grade sentence boundaries for
  //      every script (Devanagari ।॥, Arabic ؟ ۔, CJK 。！？, fullwidth
  //      ！？, etc.) with zero manual character lists. Available in all
  //      modern browsers (Chrome 87+, Firefox 126+, Safari 14.1+).
  //
  //   2. Extended-Unicode regex fallback — for browsers without
  //      Intl.Segmenter. Covers the same scripts via explicit code-point
  //      ranges, so it degrades gracefully rather than breaking.

  var _sentenceSeg;
  function _getSentenceSegmenter() {
    if (_sentenceSeg === undefined) {
      _sentenceSeg = (typeof Intl !== 'undefined' &&
        typeof Intl.Segmenter === 'function')
        ? new Intl.Segmenter([], { granularity: 'sentence' })
        : null;
    }
    return _sentenceSeg;
  }

  // Extended Unicode punctuation classes (fallback path only).
  // Terminal: ASCII .!?, Devanagari ।॥, Arabic ؟ ۔, CJK 。！？, fullwidth.
  // Break:    ASCII ,;, Arabic ،؛, CJK ，；、, ideographic comma.
  var _TERM = /[\u002E\u0021\u003F\u0964\u0965\u061F\u06D4\u3002\uFF01\uFF1F]/;
  var _BREAK = /[\u002C\u003B\u060C\u061B\uFF0C\uFF1B\u3001]/;
  var _WS = /\s/;
  var _CLOSING = /[\u0022\u0027\u201D\u2019\u2018\u0029\u005D\u007D]/;

  function IncrementalSentenceBuffer() {
    this.streamId = '';
    this.buffer = '';
  }

  IncrementalSentenceBuffer.prototype.reset = function (streamId) {
    this.streamId = String(streamId || '');
    this.buffer = '';
  };

  IncrementalSentenceBuffer.prototype.push = function (delta) {
    this.buffer += String(delta || '');
    if (!this.buffer) return [];
    var complete = [];
    var seg = _getSentenceSegmenter();

    // ── Primary: Intl.Segmenter ──────────────────────────────────────
    if (seg) {
      var segments = Array.from(seg.segment(this.buffer));
      var kept = '';
      for (var i = 0; i < segments.length; i++) {
        var isLast = i === segments.length - 1;
        // A segment is COMPLETE when it is not the last one, or when it ends
        // with an unambiguous sentence terminal. '.' is intentionally NOT in
        // this set: a trailing period may still become a decimal (2.1) or
        // abbreviation, so it waits for more text (or the final flush).
        // Everything else in _TERM — ! ? । ॥ ؟ ۔ ！ ？ 。 — is an unambiguous
        // boundary per ICU, so the last sentence of a stream is spoken
        // immediately instead of being held until flush().
        var raw = segments[i].segment;
        var s = raw.trim();
        if (!s) continue;
        var endsWithTerminal = /[!?\u0964\u0965\u061F\u06D4\u3002\uFF01\uFF1F]$/.test(s);
        if (!isLast || endsWithTerminal) {
          complete.push(s);
        } else {
          // Keep the RAW (untrimmed) segment as the residual buffer — its
          // trailing whitespace is the separator before the next word.
          kept = raw;
        }
      }
      this.buffer = kept;
      // Safety valve: break very long unbroken segments at comma/semicolon
      // so TTS doesn't stall on run-on sentences without natural boundaries.
      if (this.buffer.length > 200) {
        var cut = this._findBreak();
        if (cut >= 0) {
          complete.push(this.buffer.slice(0, cut).trim());
          this.buffer = this.buffer.slice(cut).replace(/^\s+/, '');
        }
      }
      return complete;
    }

    // ── Fallback: regex scan with extended Unicode punctuation ────────
    var start = 0;
    for (var j = 0; j < this.buffer.length; j++) {
      var ch = this.buffer[j];

      // Secondary break: comma / semicolon after 60+ accumulated chars.
      if (_BREAK.test(ch)) {
        var nb = this.buffer[j + 1] || '';
        if (nb && !_WS.test(nb)) continue;
        if (j - start < 60) continue;
        var segB = this.buffer.slice(start, j).trim();
        if (segB) complete.push(segB);
        start = j + 1;
        while (start < this.buffer.length && _WS.test(this.buffer[start])) start++;
        j = start - 1;
        continue;
      }

      if (!_TERM.test(ch)) continue;

      var nextT = this.buffer[j + 1] || '';
      var atEnd = j === this.buffer.length - 1;
      // ASCII period is ambiguous (decimal 2.1, abbreviations, ellipsis …).
      // All other terminal marks are unambiguous sentence boundaries.
      var terminal = (ch === '\u002E') ? (_WS.test(nextT) || atEnd) : true;
      if (!terminal) continue;

      var end = j + 1;
      while (end < this.buffer.length && _CLOSING.test(this.buffer[end])) end++;
      if (end < this.buffer.length && !_WS.test(this.buffer[end])) continue;

      var sentence = this.buffer.slice(start, end).trim();
      if (sentence) complete.push(sentence);
      start = end;
      while (start < this.buffer.length && _WS.test(this.buffer[start])) start++;
      j = start - 1;
    }
    this.buffer = this.buffer.slice(start);
    return complete;
  };

  // Find a comma/semicolon break point past the 60-char mark (safety valve).
  IncrementalSentenceBuffer.prototype._findBreak = function () {
    for (var i = 60; i < this.buffer.length; i++) {
      if (_BREAK.test(this.buffer[i])) {
        var next = this.buffer[i + 1] || '';
        if (!next || _WS.test(next)) return i;
      }
    }
    return -1;
  };

  IncrementalSentenceBuffer.prototype.flush = function () {
    var tail = this.buffer.trim();
    this.buffer = '';
    return tail;
  };

  return {
    ensurePlaybackToken: ensurePlaybackToken,
    phaseAfterStt: phaseAfterStt,
    withTimeout: withTimeout,
    withRateLimitRetry: withRateLimitRetry,
    IncrementalSentenceBuffer: IncrementalSentenceBuffer,
  };
});
