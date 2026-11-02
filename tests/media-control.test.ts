import test from 'node:test';
import assert from 'node:assert/strict';
import { controlMedia } from '../src/media-control.js';

test('media controls use fixed Windows media keys without incorporating user input', async () => {
  const calls: unknown[][] = [];
  const run = async (...args: unknown[]) => { calls.push(args); return { stdout: '', stderr: '' }; };
  await controlMedia('playpause', run as never);
  await controlMedia('next', run as never);
  await controlMedia('previous', run as never);
  assert.equal(calls.length, 3);
  assert.match(String(calls[0][1]), /179/);
  assert.match(String(calls[1][1]), /176/);
  assert.match(String(calls[2][1]), /177/);
  await assert.rejects(controlMedia('unknown' as never, run as never), /Unknown/);
});
