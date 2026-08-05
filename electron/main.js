/* ============================================================
   JOI — desktop EXE (Electron main process).
   Embeds the local Node server (server.js) in-process and opens
   her own window pointed at http://127.0.0.1:4173. Everything —
   chat, Ollama brain, neural TTS, second brain — runs locally.
   ============================================================ */
'use strict';

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const net = require('net');

let win = null;
let joiServer = null;

/* is something already listening on 127.0.0.1:4173? */
function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 400);
  });
}

/* tiny HTML-safe banner for the preload (not used — pure localhost) */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#04060c',
    title: 'JOI — Holographic Companion',
    icon: path.join(__dirname, '..', 'public', 'img', 'images.jpg'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL('http://127.0.0.1:4173/');

  /* open external links in the default browser, not inside her */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

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
  setTimeout(createWindow, 400);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
app.on('quit', stopServer);
