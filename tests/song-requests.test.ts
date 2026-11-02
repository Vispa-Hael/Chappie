import test from 'node:test';
import assert from 'node:assert/strict';
import { SongRequestBoard, SongRequestError } from '../src/remote/song-requests.js';
import { createRemoteService } from '../src/remote/service.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

test('song requests validate titles, notes and links without resolving media', () => {
  const board = new SongRequestBoard(() => 1000);
  assert.throws(() => board.create('g','u','Friend',{}), SongRequestError);
  for (const url of ['http://example.com/song','javascript:alert(1)','https://user:password@example.com/song','https://example.com/\nsong']) {
    assert.throws(() => board.create('g','u','Friend',{url}), SongRequestError);
  }
  assert.throws(() => board.create('g','u','Friend',{title:'x'.repeat(161)}), SongRequestError);
  assert.throws(() => board.create('g','u','Friend',{title:'song',note:'x'.repeat(301)}), SongRequestError);
  const first = board.create('g','u','Friend',{url:'https://example.com/song-one'});
  const second = board.create('g','u','Friend',{url:'https://example.com/song-two'});
  assert.equal(first.title,'example.com');assert.equal(first.status,'requested');assert.notEqual(first.id,second.id);
  assert.throws(() => board.create('g','u','Friend',{url:'https://example.com/song-one'}), /already/);
});

test('moderation belongs to the active broadcaster and requesters can only cancel their own active entries', () => {
  const board = new SongRequestBoard(() => 1000);
  const song = board.create('g','alice','Alice',{title:'A song'});
  assert.throws(() => board.action('g',song.id,'bob',undefined,'accept'), /active broadcaster/);
  assert.throws(() => board.action('g',song.id,'bob','bob','played'), /Accept/);
  assert.throws(() => board.action('g',song.id,'bob','bob','cancel'), /own/);
  assert.equal(board.action('g',song.id,'bob','bob','accept').status,'accepted');
  // Requests survive a change of broadcaster, whose approval is explicit.
  assert.throws(() => board.action('g',song.id,'bob','charlie','played'), /active broadcaster/);
  assert.equal(board.action('g',song.id,'charlie','charlie','played').status,'played');
  assert.throws(() => board.action('g',song.id,'alice','charlie','cancel'), /finished/);
  const cancel = board.create('g','alice','Alice',{title:'Another song'});
  assert.equal(board.action('g',cancel.id,'alice',undefined,'cancel').status,'cancelled');
  assert.throws(() => board.action('other',song.id,'charlie','charlie','accept'), /not found/);
});

test('request board bounds active/user/history entries and expires them after a day', () => {
  let time = 1000; const board = new SongRequestBoard(() => time);
  for(let user=0;user<10;user++)for(let n=0;n<5;n++)board.create('g',`u${user}`,`User${user}`,{title:`song${n}`});
  assert.throws(() => board.create('g','u0','User0',{title:'sixth'}), /five/);
  assert.throws(() => board.create('g','u11','User11',{title:'song'}), /full/);
  assert.equal(board.list(new Set(['g'])).length,50);assert.equal(board.list(new Set(['other'])).length,0);
  time += 24*60*60_000;assert.equal(board.list(new Set(['g'])).length,0);
  for(let n=0;n<105;n++){const row=board.create('g','u','User',{title:`history${n}`});time++;board.action('g',row.id,'u',undefined,'cancel');}
  assert.equal(board.list(new Set(['g'])).length,100);
});

test('authenticated HTTP board enforces eligibility, broadcaster review, requester cancellation and visibility', async () => {
  const directory=await mkdtemp(join(tmpdir(),'chappie-songs-'));
  const ALICE='100000000000000001',BOB='100000000000000002';const present=new Set([ALICE,BOB]);
  const channel={guildId:'guild',guildName:'Guild',channelId:'voice',channelName:'Voice'};
  const service=await createRemoteService({async context(user){return present.has(user)?[channel]:[];},async start(_g,_u,pcm){pcm.resume();},stop(){}},
    {port:0,quiet:true,devicesFile:join(directory,'devices.json')});
  const address=service.server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  async function api(path:string,body?:object,token?:string){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
  async function pair(user:string,name:string){const p=await api('/v1/pair',{});await service.approvePair(p.data.code,user,name);return (await api('/v1/pair/status',{requestId:p.data.requestId,pollSecret:p.data.pollSecret})).data.token as string;}
  let socket:WebSocket|undefined;
  try {
    const alice=await pair(ALICE,'Alice'),bob=await pair(BOB,'Bob');
    assert.equal((await api('/v1/song-request',{guildId:'guild',title:'Song'})).status,401);
    const created=await api('/v1/song-request',{guildId:'guild',title:'Song',note:'Please play this'},alice);
    assert.equal(created.status,201);assert.equal(created.data.request.userName,'Alice');
    const action=(kind:string,token:string)=>api('/v1/song-request-action',{guildId:'guild',requestId:created.data.request.id,action:kind},token);
    assert.equal((await action('accept',bob)).status,403);
    assert.equal((await action('cancel',bob)).status,403);
    const claim=await api('/v1/claim',{guildId:'guild'},bob);
    assert.equal((await action('accept',bob)).status,403,'A reserved but unattached claim is not active playback');
    socket=new WebSocket(origin.replace('http:','ws:')+claim.data.websocketPath,{headers:{Authorization:`Bearer ${bob}`}});
    let ready=false;socket.on('message',data=>{if(JSON.parse(data.toString()).type==='ready')ready=true;});await once(socket,'open');
    const until=Date.now()+1500;while(!ready&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(ready);
    assert.equal((await action('played',bob)).status,409);
    assert.equal((await action('accept',bob)).data.request.status,'accepted');
    const visible=await api('/v1/context',undefined,alice);assert.equal(visible.data.songRequests[0].status,'accepted');
    present.delete(ALICE);
    assert.deepEqual((await api('/v1/context',undefined,alice)).data.songRequests,[]);
    assert.equal((await action('cancel',alice)).status,403);
    present.add(ALICE);assert.equal((await action('cancel',alice)).data.request.status,'cancelled');
    assert.equal((await api('/v1/song-request',{guildId:'foreign',title:'Song'},alice)).status,403);
    assert.equal((await api('/v1/song-request',{guildId:'guild',url:'file:///private'},alice)).status,400);
  } finally {socket?.terminate();await service.shutdown();await rm(directory,{recursive:true,force:true});}
});
