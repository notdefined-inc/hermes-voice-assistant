'use strict';

const assert = require('node:assert/strict');
const {
  ensurePlaybackToken,
  phaseAfterStt,
  withTimeout,
  withRateLimitRetry,
  IncrementalSentenceBuffer,
} = require('../assets/streaming-voice-pipeline.js');

function testVoicePlaybackStartsGenerationWhenCallerHasNoToken() {
  let generation = 4;
  const playback = {
    begin() { generation += 1; return generation; },
    isCurrent(token) { return token === generation; },
  };
  const token = ensurePlaybackToken(playback);
  assert.equal(token, 5);
  assert.equal(playback.isCurrent(token), true);
  assert.equal(ensurePlaybackToken(playback, token), token);
}

function testEmptyOrFailedSttAlwaysLeavesTranscribingState() {
  assert.equal(phaseAfterStt({ pendingStt: 0, expectingReply: false, ttsActive: false }), 'listening');
  assert.equal(phaseAfterStt({ pendingStt: 0, expectingReply: true, ttsActive: false }), 'processing');
  assert.equal(phaseAfterStt({ pendingStt: 1, expectingReply: false, ttsActive: false }), 'transcribing');
  assert.equal(phaseAfterStt({ pendingStt: 0, expectingReply: false, ttsActive: true }), 'speaking');
}

function testTokenTextYieldsEveryCompleteSentenceNotOnlyFinalAnswer() {
  const b = new IncrementalSentenceBuffer();
  assert.deepEqual(b.push('First answer. Sec'), ['First answer.']);
  assert.deepEqual(b.push('ond answer? Third'), ['Second answer?']);
  assert.deepEqual(b.push(' answer!'), ['Third answer!']);
  assert.equal(b.flush(), '');
}

function testIncompleteTextWaitsAndFinalFlushSpeaksItOnce() {
  const b = new IncrementalSentenceBuffer();
  assert.deepEqual(b.push('The value is 2.1 GB and still'), []);
  assert.equal(b.flush(), 'The value is 2.1 GB and still');
  assert.equal(b.flush(), '');
}

function testNewStreamDropsUnspokenOldStreamTail() {
  const b = new IncrementalSentenceBuffer();
  b.reset('stream-a');
  assert.deepEqual(b.push('Old unfinished thought'), []);
  b.reset('stream-b');
  assert.deepEqual(b.push('New answer. More'), ['New answer.']);
  assert.equal(b.flush(), 'More');
}

async function testHungSttIsRejectedByDeadline() {
  const timers = {
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
  };
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 1000, timers),
    /timed out/
  );
}

async function testStreamingTtsRetriesOneRateLimitedSentence() {
  let calls = 0;
  const timers = {
    setTimeout(fn) { fn(); return 1; },
  };
  const response = await withRateLimitRetry(() => {
    calls += 1;
    return Promise.resolve({ status: calls === 1 ? 429 : 200 });
  }, 2000, timers);
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
}

async function main() {
  for (const test of [
    testVoicePlaybackStartsGenerationWhenCallerHasNoToken,
    testEmptyOrFailedSttAlwaysLeavesTranscribingState,
    testTokenTextYieldsEveryCompleteSentenceNotOnlyFinalAnswer,
    testIncompleteTextWaitsAndFinalFlushSpeaksItOnce,
    testNewStreamDropsUnspokenOldStreamTail,
  ]) test();
  await testHungSttIsRejectedByDeadline();
  await testStreamingTtsRetriesOneRateLimitedSentence();
  console.log('streaming voice pipeline tests passed');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
