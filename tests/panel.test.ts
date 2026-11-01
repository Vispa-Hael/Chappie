import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPanel } from '../src/panel.js';
import { inventory, parseItems } from '../src/routing.js';

test('routing inventory excludes Discord/system processes and keeps only available outputs', () => {
  const items = parseItems('\uFEFF' + JSON.stringify([
    {Type:'Device',Direction:'Render',Name:'CABLE Input','Device Name':'VB-Audio Virtual Cable','Device State':'Active','Item ID':'cable'},
    {Type:'Device',Direction:'Render',Name:'Speakers','Device Name':'USB','Device State':'Active','Item ID':'headphones',Default:'Render'},
    {Type:'Device',Direction:'Render',Name:'Gone','Device Name':'Old','Device State':'Disabled','Item ID':'gone'},
    ...['chrome.exe','Discord.exe','node.exe','svchost.exe'].map(name => ({Type:'Application',Direction:'Render',Name:name,'Process Path':`C:\\Apps\\${name}`})),
  ]));
  const result = inventory(items);
  assert.equal(result.cableId,'cable');
  assert.deepEqual(result.apps.map(app=>app.id),['chrome.exe']);
  assert.equal(result.privateOutputs.length,1);
  assert.equal(result.privateOutputs[0].isDefault,true);
});

test('On routes and starts; Off stops and restores; failed starts roll back; web requests are protected', async () => {
  const directory = await mkdtemp(join(tmpdir(),'chappie-panel-'));
  const routes: string[] = [];
  let running=false, fail=false;
  const server = await startPanel({
    async start(){if(fail)throw Error('Join voice first.');running=true;return 'test channel';},
    stop(){running=false;},status(){return {broadcasting:running,channels:running?['test']:[]};},
  },{port:0,quiet:true,stateFile:pathToFileURL(join(directory,'state.json')),
    inventory:async()=>({cableId:'cable',apps:[{id:'chrome.exe',name:'Chrome'}],privateOutputs:[{id:'headphones',name:'Headphones',isDefault:true}]}),
    route:async(app,device)=>{routes.push(`${app}:${device}`);},
  });
  const address=server.address(); assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  try {
    const page=await (await fetch(origin)).text();
    const key=page.match(/const key='([a-f0-9]+)'/)?.[1]; assert.ok(key);
    assert.equal((await fetch(origin+'/api/state')).status,403);
    const headers={'Content-Type':'application/json','x-chappie-key':key};
    assert.equal((await fetch(origin+'/api/toggle',{method:'POST',headers:{...headers,Origin:'https://example.com'},body:'{}'})).status,403);
    const post=(data:object)=>fetch(origin+'/api/toggle',{method:'POST',headers,body:JSON.stringify(data)});
    assert.equal((await post({action:'on',app:'chrome.exe'})).status,200);
    assert.equal(running,true);
    assert.equal((await post({action:'on',app:'chrome.exe'})).status,400);
    assert.equal((await post({action:'off'})).status,200);
    assert.equal(running,false);
    assert.deepEqual(routes,['chrome.exe:cable','chrome.exe:DefaultRenderDevice']);
    fail=true;
    assert.equal((await post({action:'on',app:'chrome.exe'})).status,400);
    assert.deepEqual(routes.slice(-2),['chrome.exe:cable','chrome.exe:DefaultRenderDevice']);
    assert.equal(running,false);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(directory,{recursive:true,force:true}); }
});
