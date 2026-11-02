'use strict';
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {mkdir,open,rename,unlink,readFile,lstat}=require('node:fs/promises');
const path=require('node:path');
const API='https://api.github.com/repos/Vispa-Hael/Chappie/releases?per_page=20';
const MAX_DOWNLOAD=256*1024*1024;
const ALLOWED_HOSTS=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);

function versionParts(value,tag=false){
  const match=(tag?/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/:/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).exec(value||'');
  if(!match)return null;const parts=match.slice(1).map(Number);return parts.every(Number.isSafeInteger)?parts:null;
}
function compareVersions(a,b){
  const left=versionParts(a),right=versionParts(b);if(!left||!right)throw Error('Invalid application version.');
  for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]>right[i]?1:-1;}return 0;
}
function trustedURL(raw){
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!ALLOWED_HOSTS.has(url.hostname))throw Error('The update points to an untrusted download address.');
  return url;
}
function assetURL(asset,tag,name){
  const url=trustedURL(asset?.browser_download_url);
  if(url.hostname!=='github.com'||url.search||url.hash||url.pathname!==`/Vispa-Hael/Chappie/releases/download/${tag}/${name}`)throw Error('The update asset does not belong to the Chappie release.');
  return url.href;
}
class UpdateManager extends EventEmitter {
  constructor({currentVersion,cacheDir,fetchImpl=fetch}){
    super();if(!versionParts(currentVersion))throw Error('Invalid current version.');
    this.currentVersion=currentVersion;this.cacheDir=path.resolve(cacheDir);this.fetch=fetchImpl;this.busy=false;this.release=null;this.downloaded=null;
    this.state={phase:'idle',currentVersion,progress:0};
  }
  snapshot(){return {...this.state};}
  changed(values){this.state={...this.state,...values};this.emit('state',this.snapshot());return this.snapshot();}
  async response(raw,timeout=15000){
    let url=trustedURL(raw);
    for(let redirects=0;redirects<=5;redirects++){
      const response=await this.fetch(url.href,{redirect:'manual',headers:{Accept:'application/vnd.github+json','User-Agent':'Chappie-Companion-Updater'},signal:AbortSignal.timeout(timeout)});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||redirects===5)throw Error('The update download redirected too many times.');
        url=trustedURL(new URL(location,url).href);continue;
      }
      if(!response.ok)throw Error(response.status===403||response.status===429?'GitHub is limiting update checks. Please try again later.':'Could not reach the Chappie update release.');
      return response;
    }
    throw Error('The update download could not be reached.');
  }
  async text(raw,limit){
    const response=await this.response(raw);let bytes=0;const chunks=[];
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit)throw Error('Update metadata is too large.');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks).toString('utf8');
  }
  async check(){
    if(this.busy)return this.snapshot();this.busy=true;
    this.release=null;this.downloaded=null;this.changed({phase:'checking',progress:0,error:undefined,availableVersion:undefined,releaseUrl:undefined});
    try{
      const releases=JSON.parse(await this.text(API,2*1024*1024));
      if(!Array.isArray(releases))throw Error('GitHub returned invalid update information.');
      const candidates=releases.filter(item=>!item.draft&&versionParts(item.tag_name,true)&&compareVersions(item.tag_name,this.currentVersion)>0).sort((a,b)=>compareVersions(b.tag_name,a.tag_name));
      if(!candidates.length)return this.changed({phase:'current'});
      const release=candidates[0],version=release.tag_name.slice(1),name=`Chappie-Companion-${version}-Setup.exe`;
      if(!Array.isArray(release.assets))throw Error('The update release has no downloadable installer.');
      const installer=release.assets.find(asset=>asset.name===name),checksums=release.assets.find(asset=>asset.name==='SHA256SUMS.txt');
      if(!installer||!checksums)throw Error('The new release is still being published. Please try again shortly.');
      if(!Number.isSafeInteger(installer.size)||installer.size<=0||installer.size>MAX_DOWNLOAD)throw Error('The update installer size is invalid.');
      const digest=/^sha256:([a-f0-9]{64})$/i.exec(installer.digest||'')?.[1]?.toLowerCase();
      if(!digest)throw Error('The release is missing its verified installer digest.');
      const installerURL=assetURL(installer,release.tag_name,name),checksumURL=assetURL(checksums,release.tag_name,'SHA256SUMS.txt');
      const lines=(await this.text(checksumURL,64*1024)).replace(/^\uFEFF/,'').split(/\r?\n/);
      const matches=lines.map(line=>/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line)).filter(match=>match&&match[2]===name);
      if(matches.length!==1||matches[0][1].toLowerCase()!==digest)throw Error('The update checksum does not match the GitHub release digest.');
      this.release={version,name,size:installer.size,digest,url:installerURL};
      return this.changed({phase:'available',availableVersion:version,releaseUrl:`https://github.com/Vispa-Hael/Chappie/releases/tag/${release.tag_name}`});
    }catch(error){return this.changed({phase:'error',error:error.message||'Could not check for updates.'});}
    finally{this.busy=false;}
  }
  async download(){
    if(this.busy)return this.snapshot();
    if(!this.release)return this.changed({phase:'error',error:'Check for an available update first.'});
    this.busy=true;this.downloaded=null;const release=this.release;
    const destination=path.join(this.cacheDir,release.name),partial=destination+'.part';let handle;
    this.changed({phase:'downloading',progress:0,error:undefined});
    try{
      await mkdir(this.cacheDir,{recursive:true});
      handle=await open(partial,'w',0o600);
      const response=await this.response(release.url,120000);
      const digest=createHash('sha256');let size=0,lastPercent=-1;
      for await(const chunk of response.body){
        const bytes=Buffer.from(chunk);size+=bytes.length;
        if(size>release.size||size>MAX_DOWNLOAD)throw Error('The update download exceeds its declared size.');
        digest.update(bytes);await handle.writeFile(bytes);
        const percent=Math.floor(size/release.size*100);if(percent!==lastPercent){lastPercent=percent;this.changed({progress:percent});}
      }
      await handle.close();handle=undefined;
      if(size!==release.size||digest.digest('hex')!==release.digest)throw Error('The downloaded update failed its size or checksum check.');
      await rename(partial,destination);this.downloaded=destination;
      return this.changed({phase:'downloaded',progress:100});
    }catch(error){await handle?.close().catch(()=>{});await unlink(partial).catch(()=>{});return this.changed({phase:'error',error:error.message||'Could not download the update.'});}
    finally{this.busy=false;}
  }
  async verifyDownloaded(){
    if(!this.downloaded||!this.release||this.state.phase!=='downloaded')throw Error('Download and verify an update before installing.');
    try{
      const info=await lstat(this.downloaded);
      if(!info.isFile()||info.isSymbolicLink()||info.size!==this.release.size)throw Error('The downloaded installer changed. Download it again.');
      const bytes=await readFile(this.downloaded);
      if(createHash('sha256').update(bytes).digest('hex')!==this.release.digest)throw Error('The downloaded installer changed. Download it again.');
      return this.downloaded;
    }catch(error){this.downloaded=null;this.changed({phase:'error',error:error.message});throw error;}
  }
}
module.exports={UpdateManager,compareVersions};
