'use strict';
const {app,BrowserWindow,ipcMain,safeStorage,shell}=require('electron');
const {readFile,writeFile,mkdir,rename}=require('node:fs/promises');
const path=require('node:path');
const {CompanionRuntime,WindowsAudio}=require('./runtime.cjs');
let window,runtime,closing=false,contextTimer;
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
    window=new BrowserWindow({width:890,height:850,minWidth:620,minHeight:650,title:'Chappie Companion',backgroundColor:'#101410',autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    runtime.on('state',state=>{if(window&&!window.isDestroyed())window.webContents.send('chappie:state',state);});
    const validSender=event=>window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame?.url===window.webContents.getURL();
    const methods={state:()=>runtime.refresh(),configure:value=>runtime.configure(value),pair:()=>runtime.pair(),toggle:()=>runtime.toggle(),requestTurn:()=>runtime.requestTurn(),handoff:id=>runtime.handoff(id),unpair:()=>runtime.unpair(),openDriverHelp:()=>shell.openExternal('https://vb-audio.com/Cable/')};
    ipcMain.handle('chappie:invoke',async(event,method,payload)=>{
      if(!validSender(event)||!Object.hasOwn(methods,method))throw Error('Unavailable action.');
      if(method==='configure'&&(typeof payload!=='object'||payload===null||Array.isArray(payload)))throw Error('Invalid setup.');
      if(method==='handoff'&&(typeof payload!=='string'||!/^\d{17,20}$/.test(payload)))throw Error('Invalid Discord user.');
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
