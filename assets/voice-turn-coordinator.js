(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.VoiceTurnCoordinator = api.VoiceTurnCoordinator;
    root.InterruptiblePlayback = api.InterruptiblePlayback;
    root.SerialVoiceTaskQueue = api.SerialTaskQueue;
    root.waitForVoiceSteerTarget = api.waitForSteerTarget;
    root.migrateVoiceCaptureSettings = api.migrateCaptureSettings;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function VoiceTurnCoordinator(options) {
    options = options || {};
    this.onFinal = options.onFinal || function () {};
    this.settleMs = options.settleMs == null ? 700 : options.settleMs;
    this.setTimeout = options.setTimeout || setTimeout.bind(globalThis);
    this.clearTimeout = options.clearTimeout || clearTimeout.bind(globalThis);
    this.pendingStt = 0;
    this.pendingDelivery = 0;
    this.turn = 0;
    this.waiting = false;
    this.turnCompleted = false;
    this.currentStreamId = null;
    this.ignoredStreamId = null;
    this.candidate = null;
    this.timer = null;
    this.timerToken = 0;
  }

  VoiceTurnCoordinator.prototype._cancel = function () {
    this.timerToken += 1;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  };

  VoiceTurnCoordinator.prototype.beginAgentTurn = function (options) {
    options = options || {};
    this._cancel();
    this.turn += 1;
    this.waiting = true;
    this.turnCompleted = false;
    this.ignoredStreamId = options.afterStreamId || null;
    this.currentStreamId = null;
    this.candidate = null;
  };

  VoiceTurnCoordinator.prototype.bindStream = function (streamId) {
    streamId = String(streamId || '');
    if (!streamId || !this.waiting) return false;
    if (this.ignoredStreamId && streamId === this.ignoredStreamId) return false;
    if (!this.currentStreamId) this.currentStreamId = streamId;
    return this.currentStreamId === streamId;
  };

  VoiceTurnCoordinator.prototype.beginStt = function () {
    this.pendingStt += 1;
    this._cancel();
  };

  VoiceTurnCoordinator.prototype.endStt = function () {
    this.pendingStt = Math.max(0, this.pendingStt - 1);
    this._schedule();
  };

  VoiceTurnCoordinator.prototype.beginDelivery = function () {
    this.pendingDelivery += 1;
    this._cancel();
  };

  VoiceTurnCoordinator.prototype.resolveDelivery = function (kind) {
    this.pendingDelivery = Math.max(0, this.pendingDelivery - 1);
    if (kind === 'steer') {
      // The accepted steer updates this same stream. Any done event that raced
      // the POST belongs to the pre-steer answer and must not reach TTS.
      this.candidate = null;
      this.turnCompleted = false;
      this.waiting = true;
      this._cancel();
      return;
    }
    this._schedule();
  };

  VoiceTurnCoordinator.prototype.noteDone = function (text, streamId) {
    if (!this.waiting) return false;
    streamId = String(streamId || '');
    if (streamId) {
      if (this.ignoredStreamId && streamId === this.ignoredStreamId) return false;
      if (!this.bindStream(streamId)) return false;
    }
    this.turnCompleted = true;
    this.candidate = { turn: this.turn, text: String(text || ''), streamId: streamId };
    this._schedule();
    return true;
  };

  // Deliver a held, complete response NOW (used right before a new turn begins).
  // The normal _schedule() path holds a finished candidate while later-follow-up
  // STT is still pending so a *steer* can merge into the same stream. But if the
  // follow-up turns out to be a NEW turn instead, that held response used to be
  // silently discarded — the user heard nothing of a fully-completed answer
  // ("only speaks the last ones"). Callers invoke this when a fresh turn is about
  // to start and no steer is possible, so the previous answer still gets spoken.
  VoiceTurnCoordinator.prototype.flushPendingFinal = function () {
    if (!this.candidate || !this.waiting) return false;
    if (this.candidate.turn !== this.turn) return false;
    var text = String(this.candidate.text || '').trim();
    this.candidate = null;
    this.turnCompleted = false;
    this.waiting = false;
    this._cancel();
    if (text) this.onFinal(text);
    return true;
  };

  VoiceTurnCoordinator.prototype._schedule = function () {
    this._cancel();
    if (!this.waiting || !this.candidate || this.pendingStt || this.pendingDelivery) return;
    var self = this;
    var token = this.timerToken;
    this.timer = this.setTimeout(function () {
      if (token !== self.timerToken) return;
      self.timer = null;
      if (!self.waiting || !self.candidate || self.pendingStt || self.pendingDelivery) return;
      var candidate = self.candidate;
      if (candidate.turn !== self.turn) return;
      self.candidate = null;
      self.waiting = false;
      self.onFinal(candidate.text);
    }, this.settleMs);
  };

  VoiceTurnCoordinator.prototype.reset = function () {
    this._cancel();
    this.pendingStt = 0;
    this.pendingDelivery = 0;
    this.waiting = false;
    this.turnCompleted = false;
    this.currentStreamId = null;
    this.ignoredStreamId = null;
    this.candidate = null;
  };

  VoiceTurnCoordinator.prototype.snapshot = function () {
    return {
      pendingStt: this.pendingStt,
      pendingDelivery: this.pendingDelivery,
      turn: this.turn,
      waiting: this.waiting,
      turnCompleted: this.turnCompleted,
      currentStreamId: this.currentStreamId,
      ignoredStreamId: this.ignoredStreamId,
      hasCandidate: !!this.candidate,
    };
  };

  function InterruptiblePlayback() {
    this.generation = 0;
    this.cancelHandler = null;
  }

  InterruptiblePlayback.prototype.begin = function () {
    this.cancel();
    return this.generation;
  };

  InterruptiblePlayback.prototype.onCancel = function (handler) {
    this.cancelHandler = typeof handler === 'function' ? handler : null;
  };

  InterruptiblePlayback.prototype.clearCancel = function (handler) {
    if (!handler || this.cancelHandler === handler) this.cancelHandler = null;
  };

  InterruptiblePlayback.prototype.cancel = function () {
    this.generation += 1;
    var handler = this.cancelHandler;
    this.cancelHandler = null;
    if (handler) handler();
  };

  InterruptiblePlayback.prototype.isCurrent = function (token) {
    return token === this.generation;
  };

  function SerialTaskQueue() {
    this.tail = Promise.resolve();
    this.length = 0;
  }

  SerialTaskQueue.prototype.add = function (task) {
    var self = this;
    self.length += 1;
    var run = self.tail.then(function () { return task(); });
    self.tail = run.then(
      function () { self.length = Math.max(0, self.length - 1); },
      function () { self.length = Math.max(0, self.length - 1); }
    );
    return run;
  };

  async function waitForSteerTarget(readState, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs == null ? 8000 : options.timeoutMs;
    var pollMs = options.pollMs == null ? 50 : options.pollMs;
    var sleep = options.sleep || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    var now = options.now || Date.now;
    var deadline = now() + timeoutMs;
    while (now() <= deadline) {
      var state = readState() || {};
      if (state.streamId) return String(state.streamId);
      if (state.turnCompleted) return null;
      await sleep(pollMs);
    }
    return null;
  }

  function migrateCaptureSettings(settings) {
    var out = {
      preRollMs: settings.preRollMs,
      minSpeechMs: settings.minSpeechMs,
      endSilenceMs: settings.endSilenceMs,
    };
    if (out.preRollMs === 300 && out.minSpeechMs === 400 && out.endSilenceMs === 650) {
      out.preRollMs = 500;
      out.minSpeechMs = 300;
      out.endSilenceMs = 1200;
    }
    return out;
  }

  return {
    VoiceTurnCoordinator: VoiceTurnCoordinator,
    InterruptiblePlayback: InterruptiblePlayback,
    SerialTaskQueue: SerialTaskQueue,
    waitForSteerTarget: waitForSteerTarget,
    migrateCaptureSettings: migrateCaptureSettings,
  };
});
