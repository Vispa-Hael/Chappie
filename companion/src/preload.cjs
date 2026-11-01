'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=(method,payload)=>ipcRenderer.invoke('chappie:invoke',method,payload);
contextBridge.exposeInMainWorld('chappie',{
  state:()=>invoke('state'),configure:data=>invoke('configure',data),pair:()=>invoke('pair'),toggle:()=>invoke('toggle'),
  requestTurn:()=>invoke('requestTurn'),handoff:userId=>invoke('handoff',userId),unpair:()=>invoke('unpair'),openDriverHelp:()=>invoke('openDriverHelp'),
  onState(callback){const listener=(_event,state)=>callback(state);ipcRenderer.on('chappie:state',listener);return()=>ipcRenderer.removeListener('chappie:state',listener);},
});
