import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RTP_OPUS_PAYLOAD_TYPE, type VoiceConnection } from '@discordjs/voice';
import { MicrophoneActivity, SpeechDucker, attachDucking } from '../src/ducking.js';

function rtp(ssrc: number) {
  const packet = Buffer.alloc(24);
  packet[0] = 0x80;
  packet[1] = RTP_OPUS_PAYLOAD_TYPE;
  packet.writeUInt32BE(ssrc, 8);
  return packet;
}

test('speech fades down in half a second and rises over two seconds after the activity tail', () => {
  const ducker = new SpeechDucker();
  assert.equal(ducker.tick(0), 1);
  ducker.activity('alice', 100);
  assert.equal(ducker.gain, 1);
  ducker.activity('alice', 200);
  assert.equal(ducker.tick(350), 0.75);
  for (let time = 400; time <= 600; time += 100) ducker.activity('alice', time);
  assert.equal(ducker.tick(600), 0.5);
  for (let time = 700; time <= 1100; time += 100) ducker.activity('alice', time);
  assert.equal(ducker.tick(1100), 0.5);
  assert.equal(ducker.tick(1350), 0.5);
  assert.equal(ducker.tick(2350), 0.75);
  assert.equal(ducker.tick(3350), 1);
  assert.equal(ducker.tick(5000), 1);
});

test('overlapping speakers keep music down; renewed speech interrupts the rise', () => {
  const ducker = new SpeechDucker();
  for (let time = 0; time <= 1000; time += 100) ducker.activity('alice', time);
  ducker.activity('bob', 1200);
  assert.equal(ducker.tick(1300), 0.5);
  assert.equal(ducker.tick(2450), 0.75);
  ducker.activity('alice', 2450);
  assert.equal(ducker.gain, 0.75);
  for (let time = 2550; time <= 3450; time += 100) ducker.activity('alice', time);
  assert.equal(ducker.tick(3450), 0.5);
  assert.equal(ducker.tick(5700), 1);
});

test('member departure releases only when no other speaker remains', () => {
  const ducker = new SpeechDucker();
  for (let time = 0; time <= 1000; time += 100) {
    ducker.activity('alice', time); ducker.activity('bob', time);
  }
  ducker.remove('alice', 1050);
  assert.equal(ducker.tick(1100), 0.5);
  ducker.remove('bob', 1100);
  assert.equal(ducker.tick(2100), 0.75);
  assert.equal(ducker.tick(3100), 1);
});

test('short speech releases from its current gain without an abrupt drop', () => {
  const ducker = new SpeechDucker();
  ducker.activity('alice', 0);
  assert.equal(ducker.tick(250), 0.75);
  assert.equal(ducker.tick(1250), 0.875);
  assert.equal(ducker.tick(2250), 1);
});

test('fade curves start and finish gently instead of changing gain at a constant rate', () => {
  const ducker = new SpeechDucker();
  ducker.activity('alice', 0);
  assert.ok(ducker.tick(50) > 0.97, 'Attack should start gently');
  ducker.activity('alice', 200);
  assert.equal(ducker.tick(250), 0.75);
  ducker.activity('alice', 400);
  assert.ok(ducker.tick(450) < 0.53, 'Attack should settle gently');
  assert.equal(ducker.tick(500), 0.5);
  assert.equal(ducker.tick(650), 0.5);
  assert.ok(ducker.tick(850) < 0.53, 'Release should start gently');
  assert.equal(ducker.tick(1650), 0.75);
  assert.ok(ducker.tick(2450) > 0.97, 'Release should settle gently');
  assert.equal(ducker.tick(2650), 1);
});

test('one continuous speaker triggers an additional smooth dip after five seconds', () => {
  const ducker = new SpeechDucker();
  for (let time = 0; time <= 4900; time += 100) ducker.activity('alice', time);
  assert.equal(ducker.gain, 0.5);
  ducker.activity('alice', 5000);
  assert.equal(ducker.gain, 0.5);
  ducker.activity('alice', 5200);
  assert.equal(ducker.tick(5250), 0.375);
  ducker.activity('alice', 5400);
  assert.equal(ducker.tick(5500), 0.25);
  assert.equal(ducker.tick(7650), 1);
});

test('separate short speakers do not accumulate toward the five-second threshold', () => {
  const ducker = new SpeechDucker();
  for (let time = 0; time <= 2900; time += 100) ducker.activity('alice', time);
  for (let time = 3000; time <= 5900; time += 100) ducker.activity('bob', time);
  assert.equal(ducker.gain, 0.5);
  ducker.tick(6200);
  ducker.activity('alice', 6300);
  for (let time = 6400; time <= 7300; time += 100) ducker.activity('alice', time);
  assert.equal(ducker.gain, 0.5);
});

test('screen-share, bots, unknown sources, and video packets never trigger ducking', () => {
  const seen: string[] = [];
  const activity = new MicrophoneActivity(id => id !== 'bot', id => seen.push(id));
  activity.control({ op: 5, d: { user_id: 'alice', ssrc: 10, speaking: 1 } });
  activity.control({ op: 5, d: { user_id: 'alice', ssrc: 11, speaking: 2 } });
  activity.control({ op: 5, d: { user_id: 'bot', ssrc: 12, speaking: 1 } });
  activity.control({ op: 5, d: { user_id: 'mixed', ssrc: 13, speaking: 3 } });
  activity.media(rtp(11)); activity.media(rtp(12)); activity.media(rtp(13)); activity.media(rtp(99));
  const video = rtp(10); video[1] = 101; activity.media(video);
  activity.media(Buffer.alloc(4));
  assert.deepEqual(seen, []);
  activity.media(rtp(10));
  assert.deepEqual(seen, ['alice']);
  activity.control({ op: 5, d: { user_id: 'alice', ssrc: 10, speaking: 0 } });
  activity.media(rtp(10));
  assert.deepEqual(seen, ['alice']);
});

test('a screen share does not erase a simultaneous microphone source for the same user', () => {
  let count = 0;
  const activity = new MicrophoneActivity(() => true, () => count++);
  activity.control({ op: 5, d: { user_id: 'alice', ssrc: 1, speaking: 1 } });
  activity.control({ op: 5, d: { user_id: 'alice', ssrc: 2, speaking: 2 } });
  activity.media(rtp(2)); activity.media(rtp(1));
  assert.equal(count, 1);
  activity.control({ op: 13, d: { user_id: 'alice' } });
  activity.media(rtp(1));
  assert.equal(count, 1);
});

test('socket listeners rebind and are removed on session cleanup', () => {
  const connection = Object.assign(new EventEmitter(), { state: {} as Record<string, unknown> });
  const ws = new EventEmitter(), udp = new EventEmitter();
  const network = Object.assign(new EventEmitter(), { state: { ws, udp } });
  connection.state = { networking: network };
  let gain = 1;
  const binding = attachDucking(connection as unknown as VoiceConnection, () => true, value => { gain = value; });
  ws.emit('packet', { op: 5, d: { user_id: 'alice', ssrc: 1, speaking: 1 } });
  udp.emit('message', rtp(1));
  assert.equal(gain, 1); // First packet begins the fade without an instantaneous drop.
  const nextUdp = new EventEmitter();
  network.state = { ws, udp: nextUdp };
  network.emit('stateChange');
  assert.equal(udp.listenerCount('message'), 0);
  assert.equal(nextUdp.listenerCount('message'), 1);
  binding.dispose();
  assert.equal(gain, 1);
  assert.equal(connection.listenerCount('stateChange'), 0);
  assert.equal(network.listenerCount('stateChange'), 0);
  assert.equal(ws.listenerCount('packet'), 0);
  assert.equal(nextUdp.listenerCount('message'), 0);
});
