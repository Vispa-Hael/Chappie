import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

test('a new pairing code is brought into view once and the button explains the next Discord action',async()=>{
  class Element {
    value='';textContent='';disabled=false;hidden=false;open=false;scrolls=0;focused=0;
    dataset:Record<string,string>={};classList={toggle(){}};
    replaceChildren(){}append(){}setAttribute(){}addEventListener(){}querySelectorAll(){return [];}
    scrollIntoView(){this.scrolls++;}focus(){this.focused++;}
  }
  const elements=new Map<string,Element>();
  const get=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
  const initial={phase:'off',host:'http://127.0.0.1:37842',apps:[],outputs:[],channels:[],sharing:[],requests:[]};
  const context=createContext({window:{chappie:{state:async()=>initial,onState(){}}},document:{getElementById:get,createElement:()=>new Element(),body:{classList:{toggle(){}}},querySelectorAll:()=>[],activeElement:null},Date});
  runInContext(await readFile(new URL('../companion/ui/app.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get('connect').textContent,'Get pairing code');
  context.next={...initial,phase:'pairing',pairing:{code:'ABCD1234',expiresAt:Date.now()+300000}};
  runInContext('render(next)',context);
  assert.equal(get('pairing').hidden,false);assert.equal(get('pair-code').textContent,'/pair ABCD1234');
  assert.equal(get('pairing').scrolls,1);assert.equal(get('pairing').focused,1);
  assert.match(get('connect').textContent,/enter it in Discord/);
  runInContext('render(next)',context);assert.equal(get('pairing').scrolls,1);
  context.next={...initial,phase:'pairing',pairing:{code:'EFGH5678',expiresAt:Date.now()+300000}};
  runInContext('render(next)',context);assert.equal(get('pairing').scrolls,2);
});
