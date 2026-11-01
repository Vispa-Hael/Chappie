import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

test('app picker stays usable while sharing, refresh completes, and changing apps restores the old route first', async () => {
  class Element {
    value=''; textContent=''; disabled=false; open=false; replacements=0;
    dataset: Record<string,string>={};
    classList={toggle(){}};
    onclick?:()=>Promise<void>; onchange?:()=>Promise<void>;
    setAttribute(){}
    replaceChildren(){this.value='';this.replacements++;}
    append(option:Element){if(!this.value)this.value=option.value;}
  }
  const elements=new Map<string,Element>();
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
  let state={broadcasting:true,channels:['Server'],busy:false,cableId:'cable',
    pending:{app:'chrome.exe',privateOutput:'DefaultRenderDevice'} as {app:string;privateOutput:string}|undefined,
    apps:[{id:'chrome.exe',name:'Chrome'},{id:'spotify.exe',name:'Spotify'}],
    privateOutputs:[{id:'headphones',name:'Headphones',isDefault:true}]};
  const calls:Record<string,string>[]=[];
  const storage=new Map<string,string>();
  const context=createContext({
    document:{getElementById:element,createElement:()=>new Element(),body:{classList:{toggle(){}}}},
    localStorage:{getItem:(id:string)=>storage.get(id),setItem:(id:string,value:string)=>storage.set(id,value)},
    setInterval(){},
    async fetch(_path:string,options:{body?:string}) {
      if(options.body){
        const data=JSON.parse(options.body);calls.push(data);
        if(data.action==='off'){state.broadcasting=false;state.pending=undefined;}
        else {state.broadcasting=true;state.pending={app:data.app,privateOutput:data.privateOutput};}
        return {ok:true,json:async()=>({message:'Switched successfully.'})};
      }
      return {ok:true,json:async()=>structuredClone(state)};
    },
  });
  const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1],context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element('app').disabled,false,'Music source must be selectable while sharing');
  const rebuilds=element('app').replacements;
  await runInContext('refresh()',context);
  assert.equal(element('app').replacements,rebuilds,'Polling must not rebuild an unchanged open picker');
  await element('refresh').onclick!();
  assert.match(element('message').textContent,/updated/);
  assert.equal(element('refresh').disabled,false);
  element('app').value='spotify.exe';
  await element('app').onchange!();
  assert.deepEqual(calls.map(call=>[call.action,call.app]),[['off',undefined],['on','spotify.exe']]);
  assert.equal(state.pending?.app,'spotify.exe');
  assert.equal(element('app').disabled,false);
  assert.equal(element('route-name').textContent,'Spotify');
});
