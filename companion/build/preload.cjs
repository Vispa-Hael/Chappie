"use strict";

// companion/src/preload.cjs
var { contextBridge, ipcRenderer } = require("electron");
var invoke = (method, payload) => ipcRenderer.invoke("chappie:invoke", method, payload);
contextBridge.exposeInMainWorld("chappie", {
  state: () => invoke("state"),
  configure: (data) => invoke("configure", data),
  pair: () => invoke("pair"),
  toggle: () => invoke("toggle"),
  requestTurn: () => invoke("requestTurn"),
  handoff: (userId) => invoke("handoff", userId),
  requestSong: (data) => invoke("requestSong", data),
  songAction: (data) => invoke("songAction", data),
  openSong: (id) => invoke("openSong", id),
  checkUpdates: () => invoke("checkUpdates"),
  downloadUpdate: () => invoke("downloadUpdate"),
  installUpdate: () => invoke("installUpdate"),
  unpair: () => invoke("unpair"),
  openDriverHelp: () => invoke("openDriverHelp"),
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("chappie:state", listener);
    return () => ipcRenderer.removeListener("chappie:state", listener);
  }
});
