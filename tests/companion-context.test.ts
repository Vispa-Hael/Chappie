import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {CompanionRuntime}=createRequire(import.meta.url)('../companion/src/runtime.cjs');
const audio={async inventory(){return {apps:[],outputs:[]};}};

test('automatic context refresh surfaces new turn requests without re-enumerating audio devices',async()=>{
  let inventories=0,queue:object[]=[];
  const runtime=new CompanionRuntime({audio:{async inventory(){inventories++;return {apps:[],outputs:[]};}},
    load:async()=>({host:'https://host.example',token:'private-device-token',user:{id:'friend'}}),save:async()=>{},
    fetchImpl:async()=>({ok:true,json:async()=>({channels:[{guildId:'guild'}],sharing:[],requests:queue})}),
  });
  await runtime.init();let pushed=false;runtime.on('state',()=>{pushed=true;});
  const before=inventories;queue=[{guildId:'guild',userId:'next-friend',userName:'Next'}];
  const state=await runtime.refreshContext();
  assert.equal(inventories,before);assert.equal(pushed,true);assert.equal(state.requests.length,1);assert.equal(state.guildId,'guild');assert.equal(state.token,undefined);
});

test('a slow context reply from an old host cannot overwrite a new unpaired configuration',async()=>{
  let deferred=false,resolveReply:(value:unknown)=>void=()=>{};
  const runtime=new CompanionRuntime({audio,load:async()=>({host:'https://old.example',token:'old-token',user:{id:'friend'}}),save:async()=>{},
    fetchImpl:async()=>({ok:true,json:async()=>deferred?new Promise(resolve=>{resolveReply=resolve;}):({channels:[],requests:[]})}),
  });
  await runtime.init();deferred=true;const refreshing=runtime.refreshContext();
  await new Promise(resolve=>setImmediate(resolve));
  await runtime.configure({host:'https://new.example'});
  resolveReply({channels:[{guildId:'old-guild'}],requests:[{userId:'old-friend'}]});await refreshing;
  assert.equal(runtime.snapshot().host,'https://new.example');assert.equal(runtime.snapshot().user,undefined);assert.deepEqual(runtime.snapshot().requests,[]);
});
