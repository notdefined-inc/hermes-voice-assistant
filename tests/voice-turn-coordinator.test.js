'use strict';

const assert = require('node:assert/strict');
const {
  VoiceTurnCoordinator,
  InterruptiblePlayback,
  SerialTaskQueue,
  waitForSteerTarget,
  migrateCaptureSettings,
} = require('../assets/voice-turn-coordinator.js');

function fakeClock() {
  const jobs = [];
  return {
    setTimeout(fn) { jobs.push(fn); return jobs.length; },
    clearTimeout() {},
    flush() { while (jobs.length) jobs.shift()(); },
  };
}

function testDefersDoneWhileSttPendingAndUsesFinalResponse() {
  const spoken = [];
  const clock = fakeClock();
  const c = new VoiceTurnCoordinator({ onFinal: t => spoken.push(t), settleMs: 1, ...clock });
  c.beginAgentTurn();
  c.bindStream('s1');
  c.beginStt();
  c.noteDone('first answer', 's1');
  clock.flush();
  assert.deepEqual(spoken, []);
  c.beginDelivery();
  c.endStt();
  c.resolveDelivery('steer');
  clock.flush();
  assert.deepEqual(spoken, []);
  c.noteDone('answer including steer', 's1');
  clock.flush();
  assert.deepEqual(spoken, ['answer including steer']);
}

function testCompletionIsMatchedToItsActualStreamNotEventCount() {
  const spoken = [];
  const clock = fakeClock();
  const c = new VoiceTurnCoordinator({ onFinal: t => spoken.push(t), settleMs: 1, ...clock });
  c.beginAgentTurn();
  c.bindStream('old-stream');
  c.beginAgentTurn({ afterStreamId: 'old-stream' });
  c.noteDone('old answer', 'old-stream');
  clock.flush();
  assert.deepEqual(spoken, []);
  c.bindStream('new-stream');
  c.noteDone('new answer', 'new-stream');
  clock.flush();
  assert.deepEqual(spoken, ['new answer']);
}

function testFailedOrEmptySttReleasesDeferredFirstAnswer() {
  const spoken = [];
  const clock = fakeClock();
  const c = new VoiceTurnCoordinator({ onFinal: t => spoken.push(t), settleMs: 1, ...clock });
  c.beginAgentTurn();
  c.bindStream('s1');
  c.beginStt();
  c.noteDone('complete answer', 's1');
  c.endStt();
  clock.flush();
  assert.deepEqual(spoken, ['complete answer']);
}

function testFlushPendingFinalDeliversHeldResponseBeforeFreshTurn() {
  const spoken = [];
  const clock = fakeClock();
  const c = new VoiceTurnCoordinator({ onFinal: t => spoken.push(t), settleMs: 1, ...clock });
  c.beginAgentTurn();
  c.bindStream('s1');
  c.beginStt();                       // follow-up STT still pending → holds candidate
  c.noteDone('full first answer', 's1');
  clock.flush();
  assert.deepEqual(spoken, []);       // intentionally deferred (steer might merge)

  // Follow-up could not steer → it becomes a fresh turn. The held complete
  // response must be delivered now, not silently discarded.
  assert.equal(c.flushPendingFinal(), true);
  assert.deepEqual(spoken, ['full first answer']);

  // The follow-up's STT resolves (endStt) with no candidate left → no noise.
  c.endStt();
  clock.flush();

  // A later fresh turn starts cleanly with no stale candidate.
  c.beginAgentTurn();                  // fresh turn (re-arms waiting)
  c.beginStt();
  c.noteDone('second answer', 's2');
  c.endStt();
  clock.flush();
  assert.deepEqual(spoken, ['full first answer', 'second answer']);
}

function testFlushPendingFinalIsNoOpWithoutHeldCandidate() {
  const spoken = [];
  const c = new VoiceTurnCoordinator({ onFinal: t => spoken.push(t), settleMs: 1 });
  c.beginAgentTurn();
  assert.equal(c.flushPendingFinal(), false);
  assert.deepEqual(spoken, []);
}

function testCaptureMigrationAddsBoundaryPaddingWithoutOverwritingCustomValues() {
  assert.deepEqual(
    migrateCaptureSettings({ preRollMs: 300, minSpeechMs: 400, endSilenceMs: 650 }),
    { preRollMs: 500, minSpeechMs: 300, endSilenceMs: 1200 }
  );
  assert.deepEqual(
    migrateCaptureSettings({ preRollMs: 700, minSpeechMs: 500, endSilenceMs: 1200 }),
    { preRollMs: 700, minSpeechMs: 500, endSilenceMs: 1200 }
  );
}

async function testLaunchGapWaitsForStreamThenSteersInsteadOfSendingMessage() {
  let reads = 0;
  const target = await waitForSteerTarget(
    () => ({ streamId: ++reads >= 3 ? 'stream-after-start' : '', turnCompleted: false }),
    { timeoutMs: 1000, pollMs: 1, sleep: () => Promise.resolve() }
  );
  assert.equal(target, 'stream-after-start');
}

async function testLaunchGapStopsWaitingWhenTurnAlreadyCompleted() {
  const target = await waitForSteerTarget(
    () => ({ streamId: '', turnCompleted: true }),
    { timeoutMs: 1000, pollMs: 1, sleep: () => Promise.resolve() }
  );
  assert.equal(target, null);
}

function testBargeInCancelsCurrentPlaybackAndInvalidatesItsCompletion() {
  const playback = new InterruptiblePlayback();
  const token = playback.begin();
  let cancelled = false;
  playback.onCancel(() => { cancelled = true; });
  playback.cancel();
  assert.equal(cancelled, true);
  assert.equal(playback.isCurrent(token), false);
}

async function testSttTasksStayInSpeechOrderAndRecoverAfterFailure() {
  const q = new SerialTaskQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = q.add(async () => { order.push('first-start'); await firstGate; order.push('first-end'); return 'one'; });
  const failed = q.add(async () => { order.push('second'); throw new Error('expected'); });
  const third = q.add(async () => { order.push('third'); return 'three'; });
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  assert.equal(await first, 'one');
  await assert.rejects(failed, /expected/);
  assert.equal(await third, 'three');
  assert.deepEqual(order, ['first-start', 'first-end', 'second', 'third']);
}

async function main() {
  for (const test of [
    testDefersDoneWhileSttPendingAndUsesFinalResponse,
    testCompletionIsMatchedToItsActualStreamNotEventCount,
    testFailedOrEmptySttReleasesDeferredFirstAnswer,
    testFlushPendingFinalDeliversHeldResponseBeforeFreshTurn,
    testFlushPendingFinalIsNoOpWithoutHeldCandidate,
    testCaptureMigrationAddsBoundaryPaddingWithoutOverwritingCustomValues,
    testBargeInCancelsCurrentPlaybackAndInvalidatesItsCompletion,
  ]) test();
  await testLaunchGapWaitsForStreamThenSteersInsteadOfSendingMessage();
  await testLaunchGapStopsWaitingWhenTurnAlreadyCompleted();
  await testSttTasksStayInSpeechOrderAndRecoverAfterFailure();
  console.log('voice-turn coordinator tests passed');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
