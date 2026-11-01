import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { createMusicResource } from '../src/audio.js';

test('music pipeline preserves bass and independent stereo channels through Opus', async () => {
  const rate = 48000;
  const amplitude = 8192;
  const pcm = Buffer.alloc(rate * 4);
  for (let i = 0; i < rate; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 60 * i / rate)), i * 4);
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 1000 * i / rate)), i * 4 + 2);
  }
  const Opus = createRequire(import.meta.url)('opusscript');
  const decoder = new Opus(rate, 2, Opus.Application.AUDIO);
  const resource = createMusicResource(Readable.from([pcm]), 100);
  const decoded: Buffer[] = [];
  try {
    for await (const packet of resource.playStream) decoded.push(Buffer.from(decoder.decode(packet)));
  } finally { decoder.delete(); resource.playStream.destroy(); }
  const audio = Buffer.concat(decoded);
  const start = 4800; // Exclude codec startup/delay; measure stable tone energy.
  const samples = Math.min(Math.floor(audio.length / 4), 43200) - start;
  assert.ok(samples > 30000);
  function toneAmplitude(channel: number, hz: number) {
    let sin = 0, cos = 0;
    for (let n = 0; n < samples; n++) {
      const i = n + start;
      const value = audio.readInt16LE(i * 4 + channel * 2);
      sin += value * Math.sin(2 * Math.PI * hz * i / rate);
      cos += value * Math.cos(2 * Math.PI * hz * i / rate);
    }
    return 2 * Math.hypot(sin, cos) / samples / amplitude;
  }
  assert.ok(toneAmplitude(0, 60) > 0.85, 'Left-channel 60 Hz bass lost');
  assert.ok(toneAmplitude(1, 1000) > 0.85, 'Right-channel midrange lost');
  assert.ok(toneAmplitude(0, 1000) < 0.1, 'Right channel leaked into left');
  assert.ok(toneAmplitude(1, 60) < 0.1, 'Bass leaked into right channel');
});
