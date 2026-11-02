import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteService } from '../src/remote/service.js';
const {CompanionRuntime,hostAddress,parseInventory}=createRequire(import.meta.url)('../companion/src/runtime.cjs');

test('companion accepts HTTPS hosts, rejects credential-bearing and insecure remote URLs',()=>{
  assert.equal(hostAddress('https://music.example.com/'),'https://music.example.com');
  assert.equal(hostAddress('http://127.0.0.1:37842'),'http://127.0.0.1:37842');
  for(const value of ['http://music.example.com','https://user:secret@example.com','https://example.com/path','https://example.com/?token=secret'])assert.throws(()=>hostAddress(value));
  const info=parseInventory(JSON.stringify([{Type:'Application',Direction:'Render','Process Path':'C:\\Apps\\Discord.exe',Name:'Discord'},{Type:'Application',Direction:'Render','Process Path':'C:\\Apps\\chrome.exe',Name:'Chrome'}]));
  assert.deepEqual(info.apps,[{id:'chrome.exe',name:'Chrome'}]);
});

test('real companion transport shares aligned PCM, releases its lease, and restores private routing on disconnect',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'chappie-client-'));
  const userId='748759971558195266';let received=0;
  const service=await createRemoteService({
    async context(){return [{guildId:'guild',guildName:'Test',channelId:'voice',channelName:'Music'}];},
    async start(_guild,_user,pcm){await new Promise<void>((resolve,reject)=>{pcm.once('data',()=>resolve());pcm.once('error',reject);});pcm.on('data',chunk=>{received+=chunk.length;});},
    stop(){},
  },{port:0,quiet:true,devicesFile:join(directory,'devices.json')});
  const address=service.server.address();assert.ok(address&&typeof address!=='string');const host=`http://127.0.0.1:${address.port}`;
  const post=async(path:string,body:object)=>{const r=await fetch(host+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
  const pair=await post('/v1/pair',{});await service.approvePair(pair.code,userId,'Friend');const approved=await post('/v1/pair/status',{requestId:pair.requestId,pollSecret:pair.pollSecret});
  const routes:string[]=[];let captureStopped=0;
  const audio={
    async inventory(){return {apps:[{id:'chrome.exe',name:'Chrome'}],outputs:[{id:'private',name:'Headphones',isDefault:true}],cableId:'cable'};},
    async route(app:string,target:string){routes.push(`${app}:${target}`);},
    capture(onData:(data:Buffer)=>void){const timer=setInterval(()=>{onData(Buffer.alloc(3));onData(Buffer.alloc(3837));},20);return {stop(){clearInterval(timer);captureStopped++;}};},
  };
  const runtime=new CompanionRuntime({audio,load:async()=>({host,app:'chrome.exe',privateOutput:'DefaultRenderDevice',guildId:'guild',token:approved.token,user:approved.user}),save:async()=>{}});
  try{
    await runtime.init();const state=await runtime.start();assert.equal(state.phase,'sharing',state.error);
    assert.equal(state.token,undefined);assert.ok(service.hasGuildLease('guild'));
    await new Promise(resolve=>setTimeout(resolve,60));assert.ok(received>0);
    await runtime.stop();assert.equal(service.hasGuildLease('guild'),false);
    assert.deepEqual(routes,['chrome.exe:cable','chrome.exe:DefaultRenderDevice']);assert.equal(captureStopped,1);
    await runtime.start();await service.stopGuild('guild');
    const until=Date.now()+2000;while(['sharing','stopping'].includes(runtime.phase)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(runtime.phase,'off');assert.equal(routes.at(-1),'chrome.exe:DefaultRenderDevice');
  }finally{await runtime.stop();await service.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('cancel during a late claim never starts capture or leaves Windows routed into the cable',async()=>{
  let finishClaim:(value:unknown)=>void=()=>{};let claimStarted:()=>void=()=>{};
  const claimed=new Promise<void>(resolve=>{claimStarted=resolve;});const routes:string[]=[];let captured=false;
  const runtime=new CompanionRuntime({audio:{async inventory(){return {apps:[{id:'chrome.exe',name:'Chrome'}],outputs:[{id:'private',name:'Phones',isDefault:true}],cableId:'cable'};},async route(_app:string,target:string){routes.push(target);},capture(){captured=true;return {stop(){}};}},
    load:async()=>({host:'https://host.example',token:'token',user:{id:'friend'},app:'chrome.exe',privateOutput:'DefaultRenderDevice',guildId:'guild'}),save:async()=>{},
    fetchImpl:async(url:string)=>({ok:true,json:async()=>{if(url.endsWith('/v1/context'))return {channels:[{guildId:'guild'}]};if(url.endsWith('/v1/claim')){claimStarted();return new Promise(resolve=>{finishClaim=resolve;});}return {};}}),
  });
  await runtime.init();const starting=runtime.start();await claimed;await runtime.stop();finishClaim({leaseId:'late',websocketPath:'/v1/audio?leaseId=late'});await starting;
  assert.equal(captured,false);assert.deepEqual(routes,[]);assert.equal(runtime.phase,'off');
});

test('recovery restores a closed app without requiring active audio and clears stale errors after refresh',async()=>{
  const calls:unknown[][]=[];
  const runtime=new CompanionRuntime({audio:{
    async inventory(){return {apps:[],outputs:[{id:'private',name:'Phones',isDefault:true}],cableId:'cable'};},
    async route(...args:unknown[]){calls.push(args);},capture(){return {stop(){}};},
  },load:async()=>({host:'https://host.example',app:'spotify.exe',privateOutput:'DefaultRenderDevice',recovery:{app:'spotify.exe',privateOutput:'DefaultRenderDevice'}}),save:async()=>{}});
  runtime.error='Old recovery warning';
  await runtime.init();
  assert.deepEqual(calls,[['spotify.exe','DefaultRenderDevice',{allowInactive:true}]]);
  assert.equal(runtime.error,'');
  assert.equal(runtime.snapshot().phase,'off');
});
