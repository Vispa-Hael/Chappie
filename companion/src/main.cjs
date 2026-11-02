'use strict';
const {app,BrowserWindow,ipcMain,safeStorage,shell,dialog}=require('electron');
const {readFile,writeFile,mkdir,rename}=require('node:fs/promises');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {CompanionRuntime,WindowsAudio}=require('./runtime.cjs');
const {UpdateManager}=require('./updater.cjs');
let window,runtime,updater,closing=false,contextTimer;
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(async()=>{
    const dataDir=app.getPath('userData');const credentials=path.join(dataDir,'device.json');
    let defaults={};try{defaults=JSON.parse(await readFile(path.join(__dirname,'../defaults.json'),'utf8'));}catch{}
    const audioDirectory=app.isPackaged?path.join(process.resourcesPath,'audio'):path.resolve(__dirname,'../../tools');
    const developmentAudio=app.isPackaged?audioDirectory:path.resolve(__dirname,'../../node_modules/ffmpeg-static');
    const audio=new WindowsAudio(audioDirectory);
    if(!app.isPackaged){audio.capture=function(onData,onError){const original=this.directory;this.directory=developmentAudio;const capture=WindowsAudio.prototype.capture.call(this,onData,onError);this.directory=original;return capture;};}
    runtime=new CompanionRuntime({audio,
      async load(){try{const value=JSON.parse(await readFile(credentials,'utf8'));if(value.encryptedToken){if(!safeStorage.isEncryptionAvailable())throw Error('Windows credential protection is unavailable.');value.token=safeStorage.decryptString(Buffer.from(value.encryptedToken,'base64'));delete value.encryptedToken;}return {...defaults,...value};}catch(error){if(error.code==='ENOENT')return defaults;throw error;}},
      async save(value){const stored={...value};if(stored.token){if(!safeStorage.isEncryptionAvailable())throw Error('Cannot save pairing securely on this PC.');stored.encryptedToken=safeStorage.encryptString(stored.token).toString('base64');}delete stored.token;await mkdir(dataDir,{recursive:true});await writeFile(credentials+'.tmp',JSON.stringify(stored),{encoding:'utf8',mode:0o600});await rename(credentials+'.tmp',credentials);},
    });
    updater=new UpdateManager({currentVersion:app.getVersion(),cacheDir:path.join(dataDir,'updates')});
    window=new BrowserWindow({width:890,height:850,minWidth:620,minHeight:650,title:'Chappie Companion',backgroundColor:'#101410',autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    const state=()=>({...runtime.snapshot(),updates:updater.snapshot()});
    const sendState=()=>{if(window&&!window.isDestroyed())window.webContents.send('chappie:state',state());};
    runtime.on('state',sendState);updater.on('state',sendState);
    const validSender=event=>window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame?.url===window.webContents.getURL();
    const methods={
      state:async()=>{await runtime.refresh();return state();},configure:async value=>{await runtime.configure(value);return state();},pair:async()=>{await runtime.pair();return state();},toggle:async()=>{await runtime.toggle();return state();},requestTurn:async()=>{await runtime.requestTurn();return state();},handoff:async id=>{await runtime.handoff(id);return state();},unpair:async()=>{await runtime.unpair();return state();},
      requestSong:async value=>{await runtime.requestSong(value);return state();},songAction:async value=>{await runtime.songAction(value.requestId,value.action);return state();},
      openSong:async requestId=>{
        const song=runtime.context.songRequests?.find(item=>item.id===requestId&&item.guildId===runtime.config.guildId&&item.status==='accepted');
        const broadcaster=runtime.context.sharing?.find(item=>item.guildId===runtime.config.guildId);
        if(!song||broadcaster?.userId!==runtime.user?.id||!song.url)throw Error('Only the current sharer can open an accepted song link.');
        const url=new URL(song.url);if(url.protocol!=='https:'||url.username||url.password)throw Error('That song link is not safe to open.');
        await shell.openExternal(url.href);return state();
      },
      checkUpdates:async()=>{await updater.check();return state();},downloadUpdate:async()=>{await updater.download();return state();},
      installUpdate:async()=>{
        const installer=await updater.verifyDownloaded();
        const answer=await dialog.showMessageBox(window,{type:'question',buttons:['Install and restart','Not now'],defaultId:1,cancelId:1,title:'Install Chappie update?',message:`Install Chappie Companion ${updater.snapshot().availableVersion}?`,detail:'Chappie will stop sharing and restore your private audio before it restarts.'});
        if(answer.response!==0)return state();
        await runtime.stop('Installing Chappie update. Private listening restored.');
        if(runtime.config.recovery)throw Error('Private audio was not restored. Close the app and try again.');
        runtime.cancelPair();
        await new Promise((resolve,reject)=>{const child=spawn(installer,['--updated','/S','--force-run'],{detached:true,windowsHide:true,stdio:'ignore',shell:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
        closing=true;clearInterval(contextTimer);app.quit();return state();
      },openDriverHelp:()=>shell.openExternal('https://vb-audio.com/Cable/')};
    ipcMain.handle('chappie:invoke',async(event,method,payload)=>{
      if(!validSender(event)||!Object.hasOwn(methods,method))throw Error('Unavailable action.');
      if(method==='configure'&&(typeof payload!=='object'||payload===null||Array.isArray(payload)))throw Error('Invalid setup.');
      if(method==='handoff'&&(typeof payload!=='string'||!/^\d{17,20}$/.test(payload)))throw Error('Invalid Discord user.');
      if(method==='requestSong'&&(typeof payload!=='object'||payload===null||Array.isArray(payload)))throw Error('Invalid song request.');
      if(method==='songAction'&&(!payload||typeof payload!=='object'||typeof payload.requestId!=='string'||!['accept','played','decline','cancel'].includes(payload.action)))throw Error('Invalid song request action.');
      if(method==='openSong'&&(typeof payload!=='string'||!/^[-a-f0-9]{36}$/i.test(payload)))throw Error('Invalid song request.');
      return methods[method](payload);
    });
    try{await runtime.init();}catch(error){runtime.error=error.message;runtime.phase='error';}
    contextTimer=setInterval(()=>{if(!closing)void runtime.refreshContext();},3000);
    contextTimer.unref();
    await window.loadFile(path.join(__dirname,'../ui/index.html'));
    window.on('close',event=>{if(closing)return;event.preventDefault();closing=true;clearInterval(contextTimer);runtime.cancelPair();void runtime.stop().finally(()=>app.quit());});
  }).catch(error=>{console.error('Chappie could not start:',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(runtime&&!closing){event.preventDefault();closing=true;clearInterval(contextTimer);runtime.cancelPair();void runtime.stop().finally(()=>app.quit());}});
}
