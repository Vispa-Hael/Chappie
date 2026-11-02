import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {UpdateManager,compareVersions}=createRequire(import.meta.url)('../companion/src/updater.cjs');
const installer=Buffer.from('test-only-installer-content');
const sha=createHash('sha256').update(installer).digest('hex');
const name='Chappie-Companion-1.2.0-Setup.exe';
const prefix='https://github.com/Vispa-Hael/Chappie/releases/download/v1.2.0/';
function release(){return {tag_name:'v1.2.0',draft:false,prerelease:true,assets:[{name,size:installer.length,digest:'sha256:'+sha,browser_download_url:prefix+name},{name:'SHA256SUMS.txt',browser_download_url:prefix+'SHA256SUMS.txt'}]};}
async function fixture(options:{release?:any;checksum?:string;bytes?:Buffer;redirect?:string}={}){
  const directory=await mkdtemp(join(tmpdir(),'chappie-updater-'));const calls:string[]=[];
  const manager=new UpdateManager({currentVersion:'1.1.2',cacheDir:directory,fetchImpl:async(url:string)=>{
    calls.push(url);
    if(url.includes('api.github.com'))return new Response(JSON.stringify([options.release??release()]));
    if(url.endsWith('SHA256SUMS.txt'))return new Response(options.checksum??`${sha}  ${name}\n`);
    if(options.redirect)return new Response(null,{status:302,headers:{location:options.redirect}});
    return new Response(new Uint8Array(options.bytes??installer));
  }});
  return {manager,calls,directory,async close(){await rm(directory,{recursive:true,force:true});}};
}
test('update checking accepts the preview channel, compares numeric versions, and requires explicit download',async()=>{
  const f=await fixture();try{const state=await f.manager.check();assert.equal(state.phase,'available');assert.equal(state.availableVersion,'1.2.0');assert.equal(f.calls.length,2);assert.equal(state.downloaded,undefined);assert.equal(compareVersions('1.10.0','1.2.0'),1);assert.equal(compareVersions('1.2.0','1.2.0'),0);}finally{await f.close();}
});
test('no newer release reports current and ignores drafts and nonnumeric release tags',async()=>{
  const item=release();item.tag_name='v1.0.0';const f=await fixture({release:item});try{assert.equal((await f.manager.check()).phase,'current');assert.equal(f.calls.length,1);item.tag_name='v2.0.0-beta';assert.equal((await f.manager.check()).phase,'current');item.tag_name='v9.0.0';item.draft=true;assert.equal((await f.manager.check()).phase,'current');}finally{await f.close();}
});
test('foreign repository, credential-bearing, and injected asset URLs are rejected',async()=>{
  for(const url of ['https://github.com/attacker/Chappie/releases/download/v1.2.0/'+name,'https://user:pass@github.com/Vispa-Hael/Chappie/releases/download/v1.2.0/'+name,prefix+name+'?other=1','https://evil.example/'+name]){
    const item=release();item.assets[0].browser_download_url=url;const f=await fixture({release:item});try{assert.equal((await f.manager.check()).phase,'error');assert.equal(f.calls.length,1);}finally{await f.close();}
  }
});
test('checksums must match the exact filename and GitHub digest before availability',async()=>{
  for(const checksum of [`${sha}  wrong.exe\n`,`${'0'.repeat(64)}  ${name}\n`,`${sha}  ${name}\n${sha}  ${name}\n`]){
    const f=await fixture({checksum});try{assert.equal((await f.manager.check()).phase,'error');assert.equal((await readdir(f.directory)).length,0);}finally{await f.close();}
  }
});
test('a valid installer downloads privately and is rehashed before install to detect tampering',async()=>{
  const f=await fixture();try{await f.manager.check();const state=await f.manager.download();assert.equal(state.phase,'downloaded');assert.equal(state.progress,100);assert.equal(state.path,undefined);const filename=await f.manager.verifyDownloaded();assert.equal(filename,join(f.directory,name));await writeFile(filename,Buffer.alloc(installer.length,0));await assert.rejects(f.manager.verifyDownloaded(),/changed/);assert.equal(f.manager.snapshot().phase,'error');}finally{await f.close();}
});
test('a corrupt download cannot be installed and its partial file is removed',async()=>{
  const f=await fixture({bytes:Buffer.alloc(installer.length,0)});try{await f.manager.check();assert.equal((await f.manager.download()).phase,'error');await assert.rejects(f.manager.verifyDownloaded());assert.deepEqual(await readdir(f.directory),[]);}finally{await f.close();}
});
test('download redirects cannot escape the trusted HTTPS GitHub delivery hosts',async()=>{
  for(const redirect of ['https://evil.example/setup.exe','http://release-assets.githubusercontent.com/setup.exe','https://release-assets.githubusercontent.com:444/setup.exe']){
    const f=await fixture({redirect});try{await f.manager.check();assert.equal((await f.manager.download()).phase,'error');assert.equal(f.calls.length,3);}finally{await f.close();}
  }
});
