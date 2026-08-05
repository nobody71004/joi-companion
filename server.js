/* ============================================================
   JOI — holographic companion
   Zero-dependency Node server.
   - Serves the app from ./public
   - POST /api/chat  → proxies to your LLM provider (Ollama,
     OpenAI, Groq, OpenRouter, LM Studio, Gemini) with streaming.
   - GET  /api/models → lists installed Ollama models (if running)
   Everything stays local; your API keys never leave this machine.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4173;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 4 * 1024 * 1024; // 4 MB request cap

/* When packaged as a desktop EXE (Electron), __dirname points inside the
   read-only app.asar, so the TTS venv and the memory file must live next
   to the executable instead. */
const IS_ELECTRON = !!(process.versions && process.versions.electron);
function packagedBase() {
  if (!IS_ELECTRON) return __dirname;
  try {
    const { app } = require('electron');
    return app.getPath('userData'); // C:\Users\<you>\AppData\Roaming\JOI
  } catch { return __dirname; }
}

/* Provider presets. Users can override base/model in the UI. */
const PRESETS = {
  ollama: {
    label: 'Ollama (local, free)',
    base: 'http://localhost:11434/v1',
    needsKey: false,
    defaultModel: 'qwen2.5-coder:3b',
  },
  lmstudio: {
    label: 'LM Studio (local, free)',
    base: 'http://localhost:1234/v1',
    needsKey: false,
    defaultModel: '',
  },
  groq: {
    label: 'Groq (free tier)',
    base: 'https://api.groq.com/openai/v1',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    base: 'https://openrouter.ai/api/v1',
    needsKey: true,
    defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com',
    needsKey: true,
    defaultModel: 'gemini-2.0-flash',
  },
  custom: { label: 'Custom (OpenAI-compatible)', base: '', needsKey: false, defaultModel: '' },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------------- helpers ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- static files ---------------- */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, 500, { error: 'Server error' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- /api/models (Ollama model list) ---------------- */

async function handleModels(res) {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return sendJson(res, 200, { running: false, models: [] });
    const data = await r.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      contextLength: m.details && m.details.context_length ? m.details.context_length : (m.context_length || 32768),
    }));
    return sendJson(res, 200, { running: true, models });
  } catch {
    return sendJson(res, 200, { running: false, models: [] });
  }
}

/* ---------------- /api/chat ---------------- */

function toOpenAIStream(headers) {
  // Relay SSE from an OpenAI-compatible endpoint verbatim.
  return { headers, transform: (body) => body };
}

function toGeminiStream(apiKey, model, messages, temperature) {
  // Convert our messages into Gemini format, call streamGenerateContent,
  // and normalize its SSE into OpenAI-style SSE so the client needs one parser.
  const sys = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.text })).join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
  const url =
    `${PRESETS.gemini.base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(apiKey)}`;
  return {
    url,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      generationConfig: { temperature: temperature ?? 0.7, maxOutputTokens: 4096 },
    }),
    transform: (body) => transformGeminiSSE(body),
  };
}

async function* transformGeminiSSE(upstream) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const msg = JSON.parse(json);
          const text = msg.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
          if (text) yield `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
        } catch { /* skip malformed frame */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const provider = body.provider || 'ollama';
  const preset = PRESETS[provider] || PRESETS.custom;
  const apiKey = (body.apiKey || '').trim();
  const model = (body.model || preset.defaultModel || '').trim();
  const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && typeof m.text === 'string') : [];
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;

  if (!model) return sendJson(res, 400, { error: 'No model selected. Pick a model in Settings first.' });
  if (!messages.length) return sendJson(res, 400, { error: 'No messages to send.' });
  if (preset.needsKey && !apiKey) {
    return sendJson(res, 400, { error: `This provider needs an API key. Open Settings (gear icon) and paste your ${provider} key.` });
  }

  const base = (body.base || preset.base || '').replace(/\/+$/, '');
  if (!base) return sendJson(res, 400, { error: 'No provider base URL configured.' });

  let cfg;
  if (provider === 'gemini') {
    cfg = toGeminiStream(apiKey, model, messages, temperature);
  } else {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost:4173';
      headers['X-Title'] = 'JOI Holographic Companion';
    }
    cfg = toOpenAIStream(headers);
    cfg.url = `${base}/chat/completions`;
    /* stream_options.include_usage asks the provider to send a final chunk
       with exact prompt/completion token counts (Ollama, LM Studio, Groq,
       OpenAI and OpenRouter all support it) — feeds the context meter. */
    cfg.body = JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.text })),
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const upstream = await fetch(cfg.url, {
      method: 'POST',
      headers: cfg.headers,
      body: cfg.body,
      signal: AbortSignal.timeout(300000),
    });

    if (!upstream.ok) {
      let detail = '';
      try {
        const j = await upstream.json();
        detail = j.error?.message || j.error || JSON.stringify(j).slice(0, 300);
      } catch {
        detail = (await upstream.text()).slice(0, 300);
      }
      res.write(`data: ${JSON.stringify({ error: `Provider error (${upstream.status}): ${detail}` })}\n\n`);
      res.end();
      return;
    }

    for await (const chunk of cfg.transform(upstream.body)) {
      res.write(chunk);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    const msg =
      err.name === 'TimeoutError'
        ? 'The model took too long to respond. For Ollama, the first reply can take a while when a big model (e.g. 32B) is cold-loading — try again now that it is warm, or pick the smaller model in Settings.'
        : `Could not reach ${base}. Is the provider running? (${err.message})`;
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  }
  res.end();
}

/* ---------------- /api/tts (Edge neural voices, free) ----------------
   Uses the Python edge-tts package in a project-local venv (set up with:
   python -m venv venv && venv/Scripts/python.exe -m pip install edge-tts) */
function findPython() {
  const cands = [
    path.join(__dirname, 'venv', 'Scripts', 'python.exe'),
    path.join(__dirname, 'venv', 'bin', 'python3'),
  ];
  if (IS_ELECTRON) {
    try {
      const { app } = require('electron');
      const base = app.getAppPath(); // packaged: ...\\resources\\app.asar
      cands.push(path.join(base, '..', '..', 'venv', 'Scripts', 'python.exe'));
      cands.push(path.join(base, '..', '..', 'venv', 'bin', 'python3'));
    } catch { /* ignore */ }
  }
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return process.platform === 'win32'
    ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'venv', 'bin', 'python3');
}
const PY = findPython();

const TTS_VOICES = {
  'en-US-JennyNeural': 'Warm & gentle (default)',
  'en-US-AriaNeural': 'Confident',
  'en-US-AnaNeural': 'Soft & intimate',
  'en-US-MichelleNeural': 'Friendly',
  'en-GB-SoniaNeural': 'British & warm',
};

const TTS_SETUP_HINT = 'cd joi-companion && python -m venv venv && venv/Scripts/python.exe -m pip install edge-tts';

async function handleTTS(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
  const text = String(body.text || '').slice(0, 2000);
  const voice = TTS_VOICES[body.voice] ? body.voice : 'en-US-MichelleNeural';
  if (!text.trim()) return sendJson(res, 400, { error: 'No text to speak' });

  const child = spawn(PY, [
    '-m', 'edge_tts', '--voice', voice,
    '--rate=-6%', '--pitch=+5Hz',
    '--text', text, '--write-media', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.on('error', () => {
    if (!res.headersSent) sendJson(res, 501, { error: 'TTS engine not set up. Run: ' + TTS_SETUP_HINT });
  });

  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  child.stdout.pipe(res);
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  child.on('close', () => { clearTimeout(timer); try { res.end(); } catch {} });
}

/* ---------------- second brain (long-term memory) ----------------
   Persistent server-side memory in data/memory.json — survives browser
   resets and server restarts. The client syncs name, facts and episodic
   memories here so JOI can "remember everything" across sessions. */
const DATA_DIR = path.join(packagedBase(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const MAX_MEMORIES = 400;

let brain = { name: '', facts: [], memories: [] };
function loadBrain() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const d = JSON.parse(raw);
    brain.name = String(d.name || '');
    brain.facts = Array.isArray(d.facts) ? d.facts.slice(0, 60) : [];
    brain.memories = Array.isArray(d.memories) ? d.memories.slice(0, MAX_MEMORIES) : [];
  } catch { /* first run */ }
}
function saveBrain() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(brain, null, 2));
  } catch (err) {
    console.error('  ✖ could not write memory file:', err.message);
  }
}

/* Merge client memory into the brain, deduping by fingerprint. */
function mergeBrain(inc) {
  if (!inc || typeof inc !== 'object') return;
  if (typeof inc.name === 'string' && inc.name.trim()) brain.name = inc.name.trim();
  if (Array.isArray(inc.facts)) {
    for (const f of inc.facts) {
      if (typeof f === 'string' && f.trim() && !brain.facts.some((x) => x.toLowerCase() === f.trim().toLowerCase())) {
        brain.facts.push(f.trim());
      }
    }
    if (brain.facts.length > 60) brain.facts = brain.facts.slice(-60);
  }
  if (Array.isArray(inc.memories)) {
    for (const m of inc.memories) {
      if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
      const text = m.text.trim();
      const fp = text.toLowerCase().replace(/\s+/g, ' ');
      const exists = brain.memories.find((x) => x.text.toLowerCase().replace(/\s+/g, ' ') === fp);
      if (exists) {
        if (m.importance > (exists.importance || 0)) exists.importance = m.importance;
        exists.lastSeen = Date.now();
      } else {
        brain.memories.push({
          text,
          category: String(m.category || 'episode'),
          importance: Number(m.importance) || 1,
          created: Date.now(),
          lastSeen: Date.now(),
        });
      }
    }
    if (brain.memories.length > MAX_MEMORIES) {
      /* keep the most important; drop oldest low-value ones */
      brain.memories.sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.lastSeen || 0) - (a.lastSeen || 0));
      brain.memories = brain.memories.slice(0, MAX_MEMORIES);
    }
  }
  saveBrain();
}

function handleMemoryGet(res) {
  sendJson(res, 200, brain);
}
function handleMemorySet(req, res) {
  readBody(req).then((body) => {
    try { mergeBrain(JSON.parse(body)); } catch { /* ignore invalid */ }
    sendJson(res, 200, brain);
  }).catch(() => sendJson(res, 400, { error: 'Bad request' }));
}
function handleMemoryClear(res) {
  brain = { name: '', facts: [], memories: [] };
  saveBrain();
  sendJson(res, 200, brain);
}

loadBrain();

/* ---------------- server control (Start / Stop / Restart from the app) ----------------
   Stop   → replies, then shuts the HTTP server down gracefully.
   Restart→ spawns a detached replacement server on the same port, then exits
            so the new process takes over (works even from a stopped state
            because the launcher scripts below reuse the same mechanism).
   The app shows an offline splash with a Start button + auto-reconnect when
   the server is down; Start-JOI.bat / Start-JOI.sh bring it back. */
let shuttingDown = false;

function spawnServer(extraEnv) {
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env, extraEnv || {});
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

function handleServerStop(res) {
  if (shuttingDown) return sendJson(res, 200, { ok: true, stopping: true });
  shuttingDown = true;
  sendJson(res, 200, { ok: true, stopped: true, msg: 'JOI server is stopping. Restart with Start-JOI.bat / Start-JOI.sh or npm start.' });
  // flush the response, then close cleanly
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  }, 150);
}

function handleServerRestart(res) {
  if (shuttingDown) return sendJson(res, 409, { error: 'Already restarting' });
  shuttingDown = true;
  const env = {};
  if (process.env.PORT) env.PORT = process.env.PORT;
  spawnServer(env);
  sendJson(res, 200, { ok: true, restarted: true, msg: 'Server is restarting — the page will reconnect automatically.' });
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  }, 300);
}

function handleServerStart(res) {
  // If this process is somehow alive but not listening, re-listen.
  sendJson(res, 200, { ok: true, msg: 'Server is already running.' });
}

/* ---------------- /api/audio-clips (your own voice-line audio) ---------------- */
function handleAudioClips(res) {
  const dir = path.join(PUBLIC_DIR, 'audio');
  fs.readdir(dir, (err, files) => {
    if (err) return sendJson(res, 200, { clips: [] });
    const clips = files.filter((f) => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f)).sort();
    sendJson(res, 200, { clips });
  });
}

/* ---------------- server ---------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && url.pathname === '/api/models') return handleModels(res);
  if (req.method === 'GET' && url.pathname === '/api/memory') return handleMemoryGet(res);
  if (req.method === 'POST' && url.pathname === '/api/memory') return handleMemorySet(req, res);
  if (req.method === 'POST' && url.pathname === '/api/memory/clear') return handleMemoryClear(res);
  if (req.method === 'GET' && url.pathname === '/api/audio-clips') return handleAudioClips(res);
  if (req.method === 'POST' && url.pathname === '/api/tts') return handleTTS(req, res);
  if (req.method === 'POST' && url.pathname === '/api/server/stop') return handleServerStop(res);
  if (req.method === 'POST' && url.pathname === '/api/server/restart') return handleServerRestart(res);
  if (req.method === 'POST' && url.pathname === '/api/server/start') return handleServerStart(res);
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return sendJson(res, 405, { error: 'Method not allowed' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ Port ${PORT} is already in use.`);
    console.error(`    Start with a different port, e.g.:  PORT=4174 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\n  ✦  JOI — holographic companion is awake');
  console.log(`      http://${HOST}:${PORT}\n`);
  if (!IS_ELECTRON) console.log('      Ctrl+C to shut her down.\n');
});

module.exports = { server, PORT, HOST, PUBLIC_DIR, spawnServer };
