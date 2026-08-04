'use strict';

const assert = require('node:assert/strict');
const {
  ElevenLabsLiveSession,
  elevenLabsBytesToBase64,
} = require('../assets/elevenlabs-live-stt-client.js');

// ── Fake WebSocket ────────────────────────────────────────────────────────
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];       // JSON strings sent by the client
    this.closed = false;
    this._server = null;  // set by the test to push messages in
  }
  static get CONNECTING() { return 0; }
  static get OPEN() { return 1; }
  static get CLOSED() { return 3; }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  _message(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  _error() { if (this.onerror) this.onerror(new Error('ws fail')); }
}

function lastSentJson(ws, n = -1) {
  return JSON.parse(ws.sent[ws.sent.length + n]);
}

async function testBase64RoundTrip() {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const b64 = elevenLabsBytesToBase64(bytes);
  const back = Uint8Array.from(Buffer.from(b64, 'base64'));
  assert.deepEqual(Array.from(back), Array.from(bytes));
  console.log('base64 round-trip OK');
}

async function testTokenFetchedAndWsConnects() {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, method: opts && opts.method });
    return { ok: true, json: async () => ({ token: 'sutkn_test_1' }) };
  };
  const sess = new ElevenLabsLiveSession({ WebSocketImpl: FakeWebSocket });
  sess.onError = (e) => { throw e; };
  const ok = sess.start();
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/stt/elevenlabs-token');
  assert.equal(calls[0].method, 'POST');
  assert.ok(sess.socket instanceof FakeWebSocket);
  assert.ok(sess.socket.url.includes('token=sutkn_test_1'));
  assert.ok(sess.socket.url.includes('model_id=scribe_v2_realtime'));
  assert.ok(sess.socket.url.includes('commit_strategy=manual'));
  assert.ok(sess.socket.url.includes('audio_format=pcm_16000'));
  sess.close();
  console.log('token fetch + WS connect OK');
}

async function testPcmStreamsAsBase64ChunksAndPartials() {
  global.fetch = async () => ({ ok: true, json: async () => ({ token: 'sutkn_test_2' }) });
  const partials = [];
  const sess = new ElevenLabsLiveSession({
    WebSocketImpl: FakeWebSocket,
    onTranscript: (t) => partials.push(t),
  });
  sess.onError = (e) => { throw e; };
  sess.start();
  await new Promise((r) => setTimeout(r, 20));
  sess.socket._open();
  // PCM chunk (16 kHz mono int16: 2 samples)
  const pcm = new Uint8Array([1, 2, 3, 4]);
  sess.pushPcm(pcm);
  assert.equal(sess.socket.sent.length, 1);
  const chunk = lastSentJson(sess.socket);
  assert.equal(chunk.message_type, 'input_audio_chunk');
  assert.equal(chunk.commit, false);
  assert.equal(chunk.sample_rate, 16000);
  assert.equal(Buffer.from(chunk.audio_base_64, 'base64').length, 4);
  // Server partial → surfaced live
  sess.socket._message({ message_type: 'partial_transcript', text: 'hello there' });
  assert.deepEqual(partials, ['hello there']);
  sess.close();
  console.log('PCM streaming + partials OK');
}

async function testFinishCommitsAndConfirmsViaCommittedTranscript() {
  global.fetch = async () => ({ ok: true, json: async () => ({ token: 'sutkn_test_3' }) });
  const sess = new ElevenLabsLiveSession({ WebSocketImpl: FakeWebSocket });
  sess.onError = (e) => { throw e; };
  sess.start();
  await new Promise((r) => setTimeout(r, 20));
  sess.socket._open();
  sess.pushPcm(new Uint8Array([1, 2, 3, 4]));
  sess.pushPcm(new Uint8Array([5, 6, 7, 8]));
  const fin = sess.finish();
  await new Promise((r) => setTimeout(r, 10));
  // finish() should have sent a commit chunk
  const commitMsg = lastSentJson(sess.socket);
  assert.equal(commitMsg.message_type, 'input_audio_chunk');
  assert.equal(commitMsg.commit, true);
  // Server commits the final text
  sess.socket._message({ message_type: 'committed_transcript', text: 'the final answer' });
  const text = await fin;
  assert.equal(text, 'the final answer');
  assert.equal(sess.confirmedViaReadyStop, true);
  assert.equal(sess.active, false); // auto-closed after commit
  console.log('finish → commit → confirmed OK');
}

async function testFinishTimesOutWithLastPartial() {
  global.fetch = async () => ({ ok: true, json: async () => ({ token: 'sutkn_test_4' }) });
  const sess = new ElevenLabsLiveSession({ WebSocketImpl: FakeWebSocket });
  sess.onError = (e) => { throw e; };
  sess.start();
  await new Promise((r) => setTimeout(r, 20));
  sess.socket._open();
  sess.pushPcm(new Uint8Array([1, 2, 3, 4]));
  sess.socket._message({ message_type: 'partial_transcript', text: 'almost done' });
  // finish() with an absurdly short timeout via the default (15s) — instead,
  // verify the timeout path resolves without hanging by simulating a close.
  const fin = sess.finish();
  const p = fin.then((t) => t);
  sess.close(); // close resolves pending finish with lastTranscript
  assert.equal(await p, 'almost done');
  assert.equal(sess.confirmedViaReadyStop, false);
  console.log('finish fallback on close OK');
}

async function testTokenFailureRaisesOnError() {
  global.fetch = async () => ({ ok: false, status: 500 });
  const errors = [];
  const sess = new ElevenLabsLiveSession({ WebSocketImpl: FakeWebSocket });
  sess.onError = (e) => errors.push(String(e.message || e));
  sess.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('token fetch failed'));
  assert.equal(sess.active, false);
  console.log('token failure → onError OK');
}

async function main() {
  await testBase64RoundTrip();
  await testTokenFetchedAndWsConnects();
  await testPcmStreamsAsBase64ChunksAndPartials();
  await testFinishCommitsAndConfirmsViaCommittedTranscript();
  await testFinishTimesOutWithLastPartial();
  await testTokenFailureRaisesOnError();
  console.log('elevenlabs live STT client tests passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
