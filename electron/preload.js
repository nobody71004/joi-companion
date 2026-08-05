/* ============================================================
   JOI — preload bridge (sandboxed, context-isolated).
   Exposes only the desktop-specific bits to the page:
   - onMute(cb): tray mute toggle → renderer
   - setMuted(bool): renderer → tray label sync
   - getAutoLaunch / setAutoLaunch: Windows startup toggle
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('joiDesktop', {
  onMute: (cb) => ipcRenderer.on('joi:mute', (_e, muted) => cb(muted)),
  setMuted: (muted) => ipcRenderer.send('joi:set-muted', !!muted),
  getAutoLaunch: () => ipcRenderer.invoke('joi:get-autostart'),
  setAutoLaunch: (v) => ipcRenderer.invoke('joi:set-autostart', !!v),
});
