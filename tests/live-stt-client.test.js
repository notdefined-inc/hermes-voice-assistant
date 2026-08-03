'use strict';

const assert = require('node:assert/strict');
const {
  PcmRingBuffer,
  LiveSttSession,
  StreamingPcm16Encoder,
  transcriptFromWlkMessage,
} = require('../assets/live-stt-client.js');

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = '';
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  send(value) { this.sent.push(value); }
  message(value) { if (this.onmessage) this.onmessage({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

function bytes(...values) { return new Uint8Array(values); }

function testRingKeepsOnlyConfiguredPreroll() {
  const ring = new PcmRingBuffer(6);
  ring.push(bytes(1, 2, 3, 4));
  ring.push(bytes(5, 6, 7, 8));
  assert.deepEqual(Array.from(ring.drain()), [3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(ring.drain()), []);
}

function testTranscriptCombinesCommittedAndPartialWithoutSilenceRows() {
  assert.equal(transcriptFromWlkMessage({
    lines: [
      { speaker: 1, text: 'First question.' },
      { speaker: -2, text: null },
      { speaker: 1, text: 'Second question?' },
    ],
    buffer_transcription: 'And a partial',
  }), 'First question. Second question? And a partial');
}

function testStreamingEncoderResamplesBrowserAudioTo16kPcm() {
  const encoder = new StreamingPcm16Encoder(48000, 16000);
  const source = new Float32Array(4800).fill(0.5); // 100ms at 48kHz
  const first = encoder.encode(source.subarray(0, 2400));
  const second = encoder.encode(source.subarray(2400));
  assert.equal(first.byteLength + second.byteLength, 3200); // 1600 int16 samples
  assert.ok(new Int16Array(first.buffer, first.byteOffset, first.byteLength / 2)[0] > 16000);
}

function testSessionQueuesPrerollUntilSocketOpensAndStreamsLivePcm() {
  FakeWebSocket.instances.length = 0;
  const updates = [];
  const session = new LiveSttSession({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://voice.test:7790/asr?language=en&mode=full',
    onTranscript: text => updates.push(text),
  });
  session.pushPcm(bytes(1, 2));
  session.start(bytes(3, 4));
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.deepEqual(Array.from(ws.sent[0]), [1, 2, 3, 4]);
  session.pushPcm(bytes(5, 6));
  assert.deepEqual(Array.from(ws.sent[1]), [5, 6]);
  ws.message({ lines: [{ speaker: 1, text: 'Hello world.' }], buffer_transcription: 'Next' });
  assert.deepEqual(updates, ['Hello world. Next']);
  session.finish();
  assert.equal(ws.sent[2].byteLength, 0);
}

for (const test of [
  testRingKeepsOnlyConfiguredPreroll,
  testTranscriptCombinesCommittedAndPartialWithoutSilenceRows,
  testStreamingEncoderResamplesBrowserAudioTo16kPcm,
  testSessionQueuesPrerollUntilSocketOpensAndStreamsLivePcm,
]) test();
console.log('live STT client tests passed');
