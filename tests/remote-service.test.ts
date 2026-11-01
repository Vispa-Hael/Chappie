import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { PassThrough } from 'node:stream';
import { createRemoteService, type RemoteChannel, type RemoteOptions } from '../src/remote/service.js';

const ALICE = '748759971558195266', BOB = '748759971558195267';
const CHANNEL: RemoteChannel = { guildId:'946564644112326676',guildName:'Test',channelId:'946564644112326677',channelName:'Voice' };
async function waitFor(check:()=>boolean, timeout=2500) {
  const until=Date.now()+timeout;
  while(!check()){if(Date.now()>until)throw Error('Condition timed out.');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function fixture(options:RemoteOptions={}) {
  const directory=await mkdtemp(join(tmpdir(),'chappie-remote-'));
  const devicesFile=join(directory,'devices.json');
  const present=new Set([ALICE,BOB]);
  const starts:string[]=[],stops:string[]=[],audio:Buffer[]=[];
  const service=await createRemoteService({
    async context(user){return present.has(user)?[CHANNEL]:[];},
    async start(guild,user,pcm){starts.push(`${guild}:${user}`);pcm.on('data',(chunk:Buffer)=>audio.push(Buffer.from(chunk)));},
    stop(guild){stops.push(guild);},
  },{port:0,quiet:true,devicesFile,...options});
  const address=service.server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  async function api(path:string,body?:object,token?:string){
    const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  }
  async function pair(user=ALICE,name='Alice') {
    const request=await api('/v1/pair',{});assert.equal(request.status,201);
    await service.approvePair(request.data.code,user,name);
    const poll=await api('/v1/pair/status',{requestId:request.data.requestId,pollSecret:request.data.pollSecret});
    assert.equal(poll.data.status,'approved');return poll.data.token as string;
  }
  async function connect(path:string,token:string){
    const socket=new WebSocket(origin.replace('http:','ws:')+path,{headers:{Authorization:`Bearer ${token}`}});
    const messages:Record<string,string>[]=[];
    socket.on('message',data=>messages.push(JSON.parse(data.toString())));
    await once(socket,'open');
    await waitFor(()=>messages.some(message=>message.type==='accepted'));
    return {socket,messages};
  }
  return {service,api,pair,connect,present,starts,stops,audio,devicesFile,origin,
    async close(){await service.shutdown();await rm(directory,{recursive:true,force:true});}};
}

test('pairing requires both Discord approval and polling proof; only token hashes are persisted',async()=>{
  const f=await fixture();
  try{
    const request=await f.api('/v1/pair',{});
    const proof={requestId:request.data.requestId,pollSecret:request.data.pollSecret};
    assert.equal((await f.api('/v1/pair/status',proof)).data.status,'pending');
    assert.equal((await f.api('/v1/pair/status',{...proof,pollSecret:'wrong'})).status,404);
    assert.equal((await f.api('/v1/context')).status,401);
    await f.service.approvePair(request.data.code,ALICE,'Alice');
    const approved=await f.api('/v1/pair/status',proof);
    assert.equal((await f.api('/v1/context',undefined,approved.data.token)).status,200);
    const stored=await readFile(f.devicesFile,'utf8');
    assert.ok(!stored.includes(approved.data.token));
    assert.ok(!stored.includes(request.data.pollSecret));
    assert.equal(f.service.isPaired(ALICE),true);
    await assert.rejects(f.service.approvePair(request.data.code,BOB,'Bob'));
    await f.service.revokeUser(ALICE);
    assert.equal((await f.api('/v1/context',undefined,approved.data.token)).status,401);
  }finally{await f.close();}
});

test('expired pairing codes and device tokens cannot authenticate',async()=>{
  let time=1_000_000;
  const f=await fixture({now:()=>time,pairingTtlMs:50,deviceTtlMs:100});
  try{
    const stale=await f.api('/v1/pair',{});time+=51;
    await assert.rejects(f.service.approvePair(stale.data.code,ALICE,'Alice'));
    const token=await f.pair();time+=101;
    assert.equal((await f.api('/v1/context',undefined,token)).status,401);
  }finally{await f.close();}
});

test('one broadcaster per server, only claim owner can attach or release, disconnect releases the slot',async()=>{
  const f=await fixture();
  try{
    const alice=await f.pair(),bob=await f.pair(BOB,'Bob');
    const claim=await f.api('/v1/claim',{guildId:CHANNEL.guildId},alice);
    assert.equal(claim.status,201);
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},bob)).status,409);
    assert.equal((await f.api('/v1/release',{leaseId:claim.data.leaseId},bob)).status,403);
    const wrong=new WebSocket(f.origin.replace('http:','ws:')+claim.data.websocketPath,{headers:{Authorization:`Bearer ${bob}`}});
    await assert.rejects(once(wrong,'open'));
    const stream=await f.connect(claim.data.websocketPath,alice);
    stream.socket.send(Buffer.alloc(3840));
    await waitFor(()=>f.audio.length>0);
    assert.equal(f.audio[0].length,3840);
    await waitFor(()=>stream.messages.some(message=>message.type==='ready'));
    stream.socket.close();await waitFor(()=>!f.service.hasGuildLease(CHANNEL.guildId));
    assert.ok(f.stops.includes(CHANNEL.guildId));
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},bob)).status,201);
  }finally{await f.close();}
});

test('pairing alone does not permit sharing outside an eligible voice channel',async()=>{
  const f=await fixture();
  try{
    const token=await f.pair();f.present.delete(ALICE);
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},token)).status,403);
    assert.deepEqual((await f.api('/v1/context',undefined,token)).data.channels,[]);
  }finally{await f.close();}
});

test('simultaneous claims cannot both win and foreign origins cannot mutate the host',async()=>{
  const f=await fixture();
  try{
    const alice=await f.pair(),bob=await f.pair(BOB,'Bob');
    const claims=await Promise.all([f.api('/v1/claim',{guildId:CHANNEL.guildId},alice),f.api('/v1/claim',{guildId:CHANNEL.guildId},bob)]);
    assert.deepEqual(claims.map(claim=>claim.status).sort(),[201,409]);
    const lease=f.service.getGuildLease(CHANNEL.guildId);assert.ok(lease);
    assert.ok([ALICE,BOB].includes(lease.userId));
    const denied=await fetch(f.origin+'/v1/pair',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});
    assert.equal(denied.status,403);
  }finally{await f.close();}
});

test('an excessive PCM burst is rejected even when it contains valid audio frames',async()=>{
  const f=await fixture();
  try{
    const token=await f.pair();const claim=await f.api('/v1/claim',{guildId:CHANNEL.guildId},token);
    const stream=await f.connect(claim.data.websocketPath,token);
    for(let i=0;i<16;i++)stream.socket.send(Buffer.alloc(65536));
    await waitFor(()=>!f.service.hasGuildLease(CHANNEL.guildId));
    assert.ok(f.audio.reduce((size,chunk)=>size+chunk.length,0)<1024*1024);
  }finally{await f.close();}
});

test('turn requests require current broadcaster approval and reserve the next user slot',async()=>{
  const f=await fixture();
  try{
    const alice=await f.pair(),bob=await f.pair(BOB,'Bob');
    await f.api('/v1/claim',{guildId:CHANNEL.guildId},alice);
    assert.equal((await f.api('/v1/request-turn',{guildId:CHANNEL.guildId},bob)).status,200);
    assert.equal((await f.api('/v1/handoff',{guildId:CHANNEL.guildId,userId:ALICE},bob)).status,403);
    assert.equal((await f.api('/v1/handoff',{guildId:CHANNEL.guildId,userId:BOB},alice)).status,200);
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},alice)).status,409);
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},bob)).status,201);
  }finally{await f.close();}
});

test('invalid audio messages terminate the lease and abandoned claims expire',async()=>{
  const f=await fixture({claimTtlMs:200,idleMs:250});
  try{
    const token=await f.pair();
    const first=await f.api('/v1/claim',{guildId:CHANNEL.guildId},token);
    const stream=await f.connect(first.data.websocketPath,token);
    stream.socket.send('not audio');
    await waitFor(()=>!f.service.hasGuildLease(CHANNEL.guildId));
    assert.equal((await f.api('/v1/claim',{guildId:CHANNEL.guildId},token)).status,201);
    await waitFor(()=>!f.service.hasGuildLease(CHANNEL.guildId));
  }finally{await f.close();}
});

test('failed remote startup cleanup carries its PCM identity and cannot stop unrelated local playback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'chappie-ownership-'));
  let localPlaying=true;
  let attempted:PassThrough|undefined;
  const stops:PassThrough[]=[];
  const remoteOwned:PassThrough|undefined=undefined;
  const service=await createRemoteService({
    async context(){return [CHANNEL];},
    async start(_guild,_user,pcm){attempted=pcm;throw Error('Local audio already playing.');},
    stop(_guild,pcm){stops.push(pcm);if(pcm===remoteOwned)localPlaying=false;},
  },{port:0,quiet:true,devicesFile:join(directory,'devices.json')});
  const address=service.server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  try{
    const request=await(await fetch(origin+'/v1/pair',{method:'POST'})).json();
    await service.approvePair(request.code,ALICE,'Alice');
    const approval=await(await fetch(origin+'/v1/pair/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:request.requestId,pollSecret:request.pollSecret})})).json();
    const claim=await(await fetch(origin+'/v1/claim',{method:'POST',headers:{Authorization:`Bearer ${approval.token}`,'Content-Type':'application/json'},body:JSON.stringify({guildId:CHANNEL.guildId})})).json();
    const ws=new WebSocket(origin.replace('http:','ws:')+claim.websocketPath,{headers:{Authorization:`Bearer ${approval.token}`}});
    ws.on('error',()=>{});
    await waitFor(()=>attempted!==undefined&&!service.hasGuildLease(CHANNEL.guildId));
    assert.ok(stops.length>0);
    assert.ok(stops.every(pcm=>pcm===attempted));
    assert.equal(localPlaying,true);
    ws.terminate();
  }finally{await service.shutdown();await rm(directory,{recursive:true,force:true});}
});
