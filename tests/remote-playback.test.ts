import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client, GatewayIntentBits, type Guild } from 'discord.js';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { RelaySession } from '../src/session.js';

test('remote input closing during startup aborts promptly and reports its end only once',async()=>{
  const client=new Client({intents:[GatewayIntentBits.Guilds]});
  const session=new RelaySession('guild',client,'unused',50,60000);
  session.connection={state:{status:VoiceConnectionStatus.Ready},destroy(){}} as unknown as VoiceConnection;
  const input=new PassThrough();let ended=0;
  const began=Date.now();const starting=session.startRemote(input,()=>{ended++;});
  setTimeout(()=>input.destroy(),20);
  await assert.rejects(starting);
  assert.ok(Date.now()-began<1000,'Cancelled startup should not wait for the twelve-second timeout');
  assert.equal(session.broadcasting,false);assert.equal(ended,1);
  session.leave();assert.equal(ended,1);client.destroy();
});

test('a cancelled slow member lookup never creates a late voice connection',async()=>{
  const client=new Client({intents:[GatewayIntentBits.Guilds]});
  const session=new RelaySession('guild',client,'unused',50,60000);
  let resolveMember:(member:unknown)=>void=()=>{};let cancelled=false;
  const guild={members:{fetch:()=>new Promise(resolve=>{resolveMember=resolve;})}} as unknown as Guild;
  const joining=session.joinOwner(guild,'friend',()=>cancelled);
  cancelled=true;resolveMember({voice:{channel:null}});
  await assert.rejects(joining,/cancelled/);assert.equal(session.connection,undefined);client.destroy();
});
