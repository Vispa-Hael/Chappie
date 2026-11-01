import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { Capture, captureArgs, ffmpegPath } from '../src/capture.js';
import { boundedNumber } from '../src/config.js';

test('capture passes device names literally and outputs Discord PCM format', () => {
  const name = 'CABLE Output (device & literal)';
  const args = captureArgs(name);
  assert.equal(args[args.indexOf('-i') + 1], `audio=${name}`);
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args.at(-2), 's16le');
  assert.throws(() => captureArgs(''));
  assert.throws(() => captureArgs('device\nnext'));
});

test('invalid configuration is rejected instead of producing NaN audio gain', () => {
  process.env.RELAY_TEST_VOLUME = 'not-a-number';
  assert.throws(() => boundedNumber('RELAY_TEST_VOLUME', 50, 0, 100));
  process.env.RELAY_TEST_VOLUME = '-1';
  assert.throws(() => boundedNumber('RELAY_TEST_VOLUME', 50, 0, 100));
  delete process.env.RELAY_TEST_VOLUME;
  assert.equal(boundedNumber('RELAY_TEST_VOLUME', 50, 0, 100), 50);
});

test('bundled FFmpeg audio can be encoded into Opus packets', { timeout: 15_000 }, async () => {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.2', '-ac', '2', '-f', 's16le', 'pipe:1'], { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  const resource = createAudioResource(child.stdout, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume!.setVolume(0.5);
  let packets = 0;
  try {
    for await (const packet of resource.playStream) { assert.ok(packet.length > 0); packets++; }
    await exit;
    assert.ok(packets >= 10, `Expected at least 10 Opus packets, got ${packets}`);
  } finally { child.kill(); }
});

test('stopping capture terminates FFmpeg without reporting an intentional stop as failure', { timeout: 10_000 }, async () => {
  let failures = 0;
  const capture = new Capture('nonexistent-relay-test-device', () => { failures++; });
  const closed = new Promise<void>(resolve => capture.child.once('close', () => resolve()));
  capture.stop();
  capture.stop();
  await closed;
  assert.equal(failures, 0);
  assert.ok(capture.child.exitCode !== null || capture.child.signalCode !== null);
});

test('a missing recording device reports a failure once and exits', { timeout: 10_000 }, async () => {
  let failures = 0;
  await new Promise<void>((resolve, reject) => {
    const capture = new Capture('nonexistent-relay-test-device', error => {
      try { assert.match(error.message, /Audio capture ended/); failures++; resolve(); }
      catch (failure) { reject(failure); }
    });
    capture.child.stdout.resume();
  });
  assert.equal(failures, 1);
});
