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
    var complete = [];
    var start = 0;
    for (var i = 0; i < this.buffer.length; i++) {
      var ch = this.buffer[i];

      // Secondary break points: comma or semicolon. Only flush if enough text
      // has accumulated (60+ chars) to avoid choppy, unnatural TTS breaks.
      if (ch === ',' || ch === ';') {
        var next = this.buffer[i + 1] || '';
        if (!/\s/.test(next)) continue;
        var sinceStart = i - start;
        if (sinceStart < 60) continue;
        var segment = this.buffer.slice(start, i).trim();
        if (segment) complete.push(segment);
        start = i + 1;
        while (start < this.buffer.length && /\s/.test(this.buffer[start])) start += 1;
        i = start - 1;
        continue;
      }

      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      var nextT = this.buffer[i + 1] || '';
      var atEnd = i === this.buffer.length - 1;
      // A period at the current token boundary may still become a decimal (2.1),
      // abbreviation, or ellipsis. Wait for following whitespace or final flush.
      var terminal = ch === '.' ? /\s/.test(nextT) : (atEnd || /\s/.test(nextT));
      if (!terminal) continue;
      var end = i + 1;
      while (end < this.buffer.length && /["'"')]}]/.test(this.buffer[end])) end += 1;
      if (end < this.buffer.length && !/\s/.test(this.buffer[end])) continue;
      var sentence = this.buffer.slice(start, end).trim();
      if (sentence) complete.push(sentence);
      start = end;
      while (start < this.buffer.length && /\s/.test(this.buffer[start])) start += 1;
      i = start - 1;
    }
    this.buffer = this.buffer.slice(start);
    return complete;
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
