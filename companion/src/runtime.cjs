'use strict';
const {EventEmitter}=require('node:events');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const WebSocket=require('ws');
const execute=promisify(execFile);

function hostAddress(raw) {
  const url=new URL(raw);
  if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('Enter the host address without a path or login information.');
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('The Chappie host must use HTTPS.');
  return url.origin;
}
function parseInventory(raw) {
  const rows=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!Array.isArray(rows))throw Error('Could not read Windows audio devices.');
  const outputs=rows.filter(r=>r.Type==='Device'&&r.Direction==='Render'&&r['Device State']==='Active');
  const cable=outputs.find(r=>r.Name==='CABLE Input'&&/VB-Audio/i.test(r['Device Name']));
  const apps=new Map();
  for(const row of rows){
    if(row.Type!=='Application'||row.Direction!=='Render'||!row['Process Path'])continue;
    const id=path.win32.basename(row['Process Path']).toLowerCase();
    if(!/^[\w .-]+\.exe$/.test(id)||/^(discord.*|node|ffmpeg|svchost|system|audiodg|msedgewebview2|chappie.*)\.exe$/i.test(id))continue;
    apps.set(id,{id,name:row.Name||id});
  }
  return {apps:[...apps.values()],outputs:outputs.filter(r=>!/VB-Audio/i.test(r['Device Name'])).map(r=>({id:r['Item ID'],name:`${r.Name} (${r['Device Name']})`,isDefault:r.Default==='Render'})),cableId:cable?.['Item ID']};
}
class WindowsAudio {
  constructor(directory){this.directory=directory;}
  async inventory(){const {stdout}=await execute(path.join(this.directory,'svcl','svcl.exe'),['/sjson',''],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});return parseInventory(stdout);}
  async route(app,device){
    const info=await this.inventory();
    if(!info.apps.some(a=>a.id===app))throw Error('Open your music app and play audio, then refresh.');
    if(device!=='DefaultRenderDevice'&&device!==info.cableId&&!info.outputs.some(o=>o.id===device))throw Error('That audio output is no longer available.');
    await execute(path.join(this.directory,'svcl','svcl.exe'),['/SetAppDefault',device,'all',app],{windowsHide:true,timeout:10000});
  }
  capture(onData,onError){
    const child=spawn(path.join(this.directory,'ffmpeg.exe'),['-hide_banner','-loglevel','warning','-nostdin','-f','dshow','-rtbufsize','16M','-i','audio=CABLE Output (VB-Audio Virtual Cable)','-vn','-ac','2','-ar','48000','-c:a','pcm_s16le','-f','s16le','pipe:1'],{windowsHide:true});
    let stopped=false,reported=false;
    const fail=()=>{if(!stopped&&!reported){reported=true;onError(Error('Audio capture stopped. Check CABLE Output and your audio app.'));}};
    child.stdin.end();child.stdout.on('data',onData);child.stderr.resume();child.once('error',fail);child.once('close',fail);
    return {stop(){stopped=true;child.stdout.destroy();child.kill();}};
  }
}

class CompanionRuntime extends EventEmitter {
  constructor({audio,load,save,fetchImpl=fetch,Socket=WebSocket}) {
    super();this.audio=audio;this.load=load;this.save=save;this.fetch=fetchImpl;this.Socket=Socket;
    this.config={host:'',app:'chrome.exe',privateOutput:'DefaultRenderDevice'};
    this.phase='off';this.message='';this.error='';this.inventory={apps:[],outputs:[]};this.context={channels:[],sharing:[],requests:[],songRequests:[]};
    this.busy=false;this.socket=null;this.capture=null;this.lease=null;this.pairing=null;this.generation=0;this.routeQueue=Promise.resolve();this.cleanupPromise=null;this.saveQueue=Promise.resolve();
  }
  snapshot(){return {...this.config,token:undefined,recovery:undefined,phase:this.phase,user:this.user,pairing:this.pairing?{code:this.pairing.code,expiresAt:this.pairing.expiresAt}:undefined,
    error:this.error,message:this.message,apps:this.inventory.apps,outputs:this.inventory.outputs,cableReady:!!this.inventory.cableId,
    channels:this.context.channels||[],sharing:this.context.sharing||[],requests:this.context.requests||[],songRequests:this.context.songRequests||[]};}
  changed(){this.emit('state',this.snapshot());}
  persist(){const value=structuredClone({...this.config,token:this.token,user:this.user});const operation=this.saveQueue.catch(()=>{}).then(()=>this.save(value));this.saveQueue=operation;return operation;}
  async init(){
    const data=await this.load();
    if(data){this.config={host:data.host||'',app:data.app||'chrome.exe',privateOutput:data.privateOutput||'DefaultRenderDevice',guildId:data.guildId,recovery:data.recovery};this.token=data.token;this.user=data.user;}
    try{this.inventory=await this.audio.inventory();}catch{this.error='Windows audio helper is unavailable.';}
    if(this.config.recovery){try{await this.audio.route(this.config.recovery.app,this.config.recovery.privateOutput);delete this.config.recovery;await this.persist();this.message='Recovered your private audio after the previous session.';}catch{this.error='Reopen your music app, then switch off to restore private listening.';}}
    await this.refresh();return this.snapshot();
  }
  async request(endpoint,body,authenticated=true,timeout=15000){
    if(!this.config.host)throw Error('Set the Chappie host address first.');
    const response=await this.fetch(this.config.host+endpoint,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeout),
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(authenticated?{Authorization:`Bearer ${this.token||''}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'The Chappie host rejected the request.');return result;
  }
  async refresh(){
    try{this.inventory=await this.audio.inventory();if(this.token)this.context=await this.request('/v1/context');}
    catch(error){this.error=error.message;}
    if(!this.config.guildId&&this.context.channels?.length===1)this.config.guildId=this.context.channels[0].guildId;
    this.changed();return this.snapshot();
  }
  refreshContext(){
    if(!this.token||this.busy)return Promise.resolve(this.snapshot());
    if(this.contextRequest)return this.contextRequest;
    const host=this.config.host,token=this.token;
    this.contextRequest=(async()=>{
      try{
        const context=await this.request('/v1/context');
        if(this.config.host!==host||this.token!==token)return this.snapshot();
        this.context=context;
        if(this.error===this.contextError)this.error='';
        this.contextError=undefined;
        if(!this.config.guildId&&context.channels?.length===1)this.config.guildId=context.channels[0].guildId;
        this.changed();
      }catch(error){if(this.config.host===host&&this.token===token){this.contextError=error.message;this.error=error.message;this.changed();}}
      finally{this.contextRequest=null;}
      return this.snapshot();
    })();
    return this.contextRequest;
  }
  async configure(data){
    const switchSource=this.phase==='sharing'&&Object.keys(data).length===1&&data.app!==undefined;
    if(this.busy||(this.phase==='sharing'&&!switchSource))throw Error('Turn sharing off before changing setup.');
    if(switchSource){await this.stop();if(this.config.recovery)throw Error('Restore private audio before switching sources.');}
    if(data.host!==undefined){const host=hostAddress(data.host);if(host!==this.config.host){this.token=undefined;this.user=undefined;this.context={channels:[],sharing:[],requests:[],songRequests:[]};this.config.host=host;this.cancelPair();}}
    if(data.app!==undefined){if(!this.inventory.apps.some(a=>a.id===data.app))throw Error('Choose an available music app.');this.config.app=data.app;}
    if(data.privateOutput!==undefined){if(data.privateOutput!=='DefaultRenderDevice'&&!this.inventory.outputs.some(o=>o.id===data.privateOutput))throw Error('Choose an available private output.');this.config.privateOutput=data.privateOutput;}
    if(data.guildId!==undefined)this.config.guildId=String(data.guildId);
    this.error='';await this.persist();if(switchSource)return this.start();return this.refresh();
  }
  cancelPair(){clearTimeout(this.pairTimer);this.pairing=null;}
  async pair(){
    if(this.busy||this.phase==='sharing'||this.config.recovery)throw Error('Turn sharing off before pairing another device identity.');
    this.cancelPair();const details=await this.request('/v1/pair',{},false);this.pairing=details;this.phase='pairing';this.error='';this.changed();
    const poll=async()=>{
      if(this.pairing!==details)return;
      try{
        if(Date.now()>details.expiresAt)throw Error('Pairing code expired. Request a new one.');
        const result=await this.request('/v1/pair/status',{requestId:details.requestId,pollSecret:details.pollSecret},false);
        if(this.pairing!==details)return;
        if(result.status==='approved'){this.token=result.token;this.user=result.user;this.cancelPair();this.phase='off';await this.persist();await this.refresh();return;}
        this.pairTimer=setTimeout(poll,2000);
      }catch(error){if(this.pairing===details){this.cancelPair();this.phase='error';this.error=error.message;this.changed();}}
    };
    this.pairTimer=setTimeout(poll,1000);return this.snapshot();
  }
  async start(){
    if(this.busy||this.phase==='sharing')return this.snapshot();
    if(!this.token)throw Error('Pair this app with your Discord account first.');
    this.busy=true;this.phase='starting';this.error='';this.changed();const generation=++this.generation;
    const check=()=>{if(this.generation!==generation){const error=Error('Sharing cancelled.');error.cancelled=true;throw error;}};
    try{
      await this.refresh();
      check();
      if(!this.inventory.cableId)throw Error('Install VB-CABLE, then reopen this app.');
      if(this.config.privateOutput==='DefaultRenderDevice'&&!this.inventory.outputs.some(o=>o.isDefault))throw Error('Choose headphones under Setup; your Windows default output is a virtual cable.');
      if(!this.context.channels?.some(c=>c.guildId===this.config.guildId))throw Error('Join a Discord voice channel, then refresh and choose its server.');
      const claim=await this.request('/v1/claim',{guildId:this.config.guildId});this.lease=claim.leaseId;check();
      this.config.recovery={app:this.config.app,privateOutput:this.config.privateOutput};await this.persist();
      check();await this.setRoute(this.config.app,this.inventory.cableId);check();
      const base=new URL(this.config.host);const socketURL=new URL(claim.websocketPath,base);
      if(socketURL.origin!==base.origin)throw Error('The host returned an invalid stream address.');
      socketURL.protocol=socketURL.protocol==='https:'?'wss:':'ws:';
      const socket=new this.Socket(socketURL,{headers:{Authorization:`Bearer ${this.token}`},followRedirects:false,handshakeTimeout:10000});this.socket=socket;
      await new Promise((resolve,reject)=>{
        let accepted=false;let remainder=Buffer.alloc(0);const timer=setTimeout(()=>reject(Error('Chappie did not become ready.')),20000);
        const fail=error=>{clearTimeout(timer);reject(error);};
        socket.on('error',()=>fail(Error('Could not connect the audio stream.')));
        socket.on('close',()=>{fail(Error('Chappie disconnected. Your audio will be restored.'));if(this.phase==='sharing')void this.stop('Chappie disconnected; private listening restored.');});
        socket.on('message',(data,binary)=>{
          if(binary)return;let message;try{message=JSON.parse(data.toString());}catch{return;}
          if(message.type==='error'){fail(Error(message.error||message.message||'Chappie could not start.'));return;}
          if(message.type==='accepted'&&!accepted){
            if(this.generation!==generation){fail(Error('Sharing cancelled.'));return;}
            accepted=true;
            this.capture=this.audio.capture(chunk=>{
              if(socket.readyState!==WebSocket.OPEN)return;
              if(socket.bufferedAmount>512*1024){void this.stop('Connection is too slow; sharing stopped.');return;}
              const bytes=remainder.length?Buffer.concat([remainder,chunk]):chunk;
              const end=bytes.length-bytes.length%4;
              for(let offset=0;offset<end;offset+=16384)socket.send(bytes.subarray(offset,Math.min(end,offset+16384)));
              remainder=Buffer.from(bytes.subarray(end));
            },error=>{fail(error);if(this.phase==='sharing')void this.stop(error.message);});
          }
          if(message.type==='ready'){clearTimeout(timer);resolve();}
        });
      });
      if(this.generation!==generation)throw Error('Sharing cancelled.');
      this.phase='sharing';this.message='Sharing your music in Discord.';
    }catch(error){let cleanupError;try{await this.cleanup();}catch(failure){cleanupError=failure;}this.phase=error.cancelled&&!cleanupError?'off':'error';this.error=error.cancelled&&!cleanupError?'':error.message+(cleanupError?' Private audio could not be restored; reopen the app and switch off.':'');}
    finally{this.busy=false;this.changed();}
    return this.snapshot();
  }
  setRoute(app,device){const operation=this.routeQueue.catch(()=>{}).then(()=>this.audio.route(app,device));this.routeQueue=operation;return operation;}
  cleanup(){
    if(this.cleanupPromise)return this.cleanupPromise;
    this.cleanupPromise=this.doCleanup().finally(()=>{this.cleanupPromise=null;});
    return this.cleanupPromise;
  }
  async doCleanup(){
    const capture=this.capture;this.capture=null;capture?.stop();
    const socket=this.socket;this.socket=null;socket?.terminate();
    const lease=this.lease;this.lease=null;
    const releasing=lease?this.request('/v1/release',{leaseId:lease},true,2500).catch(()=>{}):Promise.resolve();
    if(this.config.recovery){await this.setRoute(this.config.recovery.app,this.config.recovery.privateOutput);delete this.config.recovery;await this.persist();}
    await releasing;
  }
  async stop(message='Chappie is off. Your music is back on your private output.'){
    if(this.stopPromise)return this.stopPromise;
    this.stopPromise=this.doStop(message).finally(()=>{this.stopPromise=null;});
    return this.stopPromise;
  }
  async doStop(message){
    ++this.generation;this.phase='stopping';this.changed();
    try{await this.cleanup();this.phase='off';this.error='';this.message=message;}catch(error){this.phase='error';this.error='Could not restore audio: '+error.message;}
    this.changed();return this.snapshot();
  }
  async toggle(){return this.phase==='sharing'||this.phase==='starting'||this.config.recovery?this.stop():this.start();}
  async requestTurn(){await this.request('/v1/request-turn',{guildId:this.config.guildId});this.message='Your turn request was sent to the current sharer.';return this.refresh();}
  async handoff(userId){await this.request('/v1/handoff',{guildId:this.config.guildId,userId});await this.stop('Your turn ended. The next person can switch on.');return this.refresh();}
  async requestSong(data){
    if(!this.config.guildId)throw Error('Choose your Discord voice channel first.');
    await this.request('/v1/song-request',{guildId:this.config.guildId,title:data?.title,url:data?.url,note:data?.note});
    this.message='Song request added to the shared board.';return this.refreshContext();
  }
  async songAction(requestId,action){
    if(!this.config.guildId)throw Error('Choose your Discord voice channel first.');
    await this.request('/v1/song-request-action',{guildId:this.config.guildId,requestId,action});
    this.message='Song request updated.';return this.refreshContext();
  }
  async unpair(){await this.stop();this.cancelPair();this.token=undefined;this.user=undefined;this.context={channels:[],sharing:[],requests:[],songRequests:[]};await this.persist();return this.snapshot();}
}
module.exports={hostAddress,parseInventory,WindowsAudio,CompanionRuntime};
