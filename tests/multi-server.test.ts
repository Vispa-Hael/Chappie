import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, GatewayIntentBits, type ChatInputCommandInteraction } from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { RelaySession } from '../src/session.js';
import type { Capture } from '../src/capture.js';

test('stopping or leaving one server does not stop capture or voice in another', () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const first = new RelaySession('first', client, 'test', 50, 60000);
  const second = new RelaySession('second', client, 'test', 50, 60000);
  let firstStops = 0, secondStops = 0, firstLeaves = 0, secondLeaves = 0;
  first.capture = { stop() { firstStops++; } } as unknown as Capture;
  second.capture = { stop() { secondStops++; } } as unknown as Capture;
  first.connection = { state: { status: VoiceConnectionStatus.Ready }, destroy() { firstLeaves++; } } as unknown as VoiceConnection;
  second.connection = { state: { status: VoiceConnectionStatus.Ready }, destroy() { secondLeaves++; } } as unknown as VoiceConnection;
  first.leave();
  assert.equal(firstStops, 1);
  assert.equal(firstLeaves, 1);
  assert.equal(secondStops, 0);
  assert.equal(secondLeaves, 0);
  assert.ok(second.capture);
  assert.ok(second.connection);
  second.leave();
  client.destroy();
});

test('volume changes and command locks belong to their own server', async () => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const first = new RelaySession('first', client, 'test', 50, 60000);
  const second = new RelaySession('second', client, 'test', 50, 60000);
  const interaction = {
    commandName: 'volume', user: { id: 'owner' },
    guild: { members: { fetch: async () => ({ voice: { channelId: 'channel' } }) } },
    options: { getInteger: () => 25 },
  } as unknown as ChatInputCommandInteraction;
  first.busy = true;
  await first.execute(interaction);
  assert.equal(first.volume, 25);
  assert.equal(second.volume, 50);
  assert.equal(second.busy, false);
  first.leave(); second.leave(); client.destroy();
});
