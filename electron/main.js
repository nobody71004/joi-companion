/* ============================================================
   JOI — desktop EXE (Electron main process).
   Embeds the local Node server (server.js) in-process and opens
   her own window pointed at http://127.0.0.1:4173. Everything —
   chat, Ollama brain, neural TTS, second brain — runs locally.

   Desktop niceties:
   - system tray: minimize/close hides her to the tray, tray click
     restores her, tray menu has mute-toggle + quit
   - launch-at-Windows-startup via app.setLoginItemSettings
   - her own purple-hologram icon (window + tray + EXE)
   ============================================================ */
'use strict';

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const net = require('net');

let win = null;
let tray = null;
let joiServer = null;
let isQuitting = false;
let voiceMuted = false;

const ICON = path.join(__dirname, '..', 'public', 'img', 'icon.png');

/* is something already listening on 127.0.0.1:4173? */
function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 400);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#04060c',
    title: 'JOI — Holographic Companion',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL('http://127.0.0.1:4173/');

  /* open external links in the default browser, not inside her */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  /* minimize → tray; close (X) → tray, unless we're truly quitting */
  win.on('minimize', (e) => { e.preventDefault(); win.hide(); });
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });

  win.on('closed', () => { win = null; });
}

/* ---------------- system tray ---------------- */
function trayImage() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  return img.resize({ width: 20, height: 20 });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else { win.show(); win.focus(); }
}

function setVoiceMuted(muted) {
  voiceMuted = !!muted;
  updateTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('joi:mute', voiceMuted);
}

function updateTrayMenu() {
  if (!tray) return;
  const showLabel = win && win.isVisible() && !win.isMinimized() ? 'Hide JOI' : 'Show JOI';
  const menu = Menu.buildFromTemplate([
    { label: showLabel, click: toggleWindow },
    { type: 'separator' },
    { label: voiceMuted ? '🔊 Unmute voice' : '🔇 Mute voice', click: () => setVoiceMuted(!voiceMuted) },
    { type: 'separator' },
    { label: 'Quit JOI', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('JOI — Holographic Companion');
  tray.on('click', () => toggleWindow());
  updateTrayMenu();
}

/* ---------------- IPC (preload bridge) ---------------- */
ipcMain.handle('joi:get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('joi:set-autostart', (_e, v) => {
  app.setLoginItemSettings({ openAtLogin: !!v, path: process.execPath });
  return !!v;
});
/* renderer → main: user flipped mute in Settings, keep tray label in sync */
ipcMain.on('joi:set-muted', (_e, muted) => setVoiceMuted(!!muted));

/* ---------------- embedded server ---------------- */
async function startServer() {
  /* If a server is already on 4173 (dev server, another instance),
     reuse it instead of crashing on EADDRINUSE. */
  if (await portTaken(4173)) {
    console.log('  ✦  reusing existing server on http://127.0.0.1:4173');
    return;
  }
  try {
    joiServer = require(path.join(__dirname, '..', 'server.js'));
    console.log('  ✦  embedded server running on http://127.0.0.1:' + joiServer.PORT);
  } catch (err) {
    console.error('  ✖  could not start embedded server:', err.message);
  }
}

function stopServer() {
  if (joiServer && joiServer.server) {
    try { joiServer.server.close(); } catch {}
    joiServer = null;
  }
}

/* ---------- lifecycle ---------- */
app.whenReady().then(async () => {
  await startServer();
  /* give the server a beat to bind before the window loads */
  setTimeout(() => {
    createWindow();
    createTray();
  }, 400);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; stopServer(); });
app.on('will-quit', () => { if (tray) { tray.destroy(); tray = null; } });
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
