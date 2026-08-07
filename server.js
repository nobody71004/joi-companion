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

/* DELAMAIN — the in-game agent (Cyberpunk 2077 + Ollama tool-calling).
   Lives in delamain.js so /api/delamain can run the same loop the
   cyber-agent CLI uses, streamed to the face UI over SSE. */
const delamain = require('./delamain.js');
const DELAMAIN_IPC = process.env.DELAMAIN_IPC || delamain.defaultIpcDir;

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

/* ---------------- GPU detection (for model-fit warnings) ---------------- */
const { spawnSync } = require('child_process');
let gpuCache = { at: 0, info: null };
function detectGPU() {
  if (Date.now() - gpuCache.at < 15000 && gpuCache.info) return gpuCache.info;
  const info = { hasGpu: false, name: '', totalGb: 0, freeGb: 0 };
  try {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3000, encoding: 'utf8', windowsHide: true }
    );
    if (r.status === 0 && r.stdout) {
      const parts = r.stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
      if (parts.length >= 3 && parts[0] && !/no nvidia/i.test(parts[0])) {
        info.hasGpu = true;
        info.name = parts[0];
        info.totalGb = +(parts[1] / 1024).toFixed(1);
        info.freeGb = +(parts[2] / 1024).toFixed(1);
      }
    }
  } catch { /* no nvidia-smi → CPU-only machine */ }
  gpuCache = { at: Date.now(), info };
  return info;
}

/* ---------------- /api/models (Ollama model list + GPU fit) ---------------- */

async function handleModels(res) {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return sendJson(res, 200, { running: false, models: [], gpu: detectGPU() });
    const data = await r.json();
    const gpu = detectGPU();
    const models = (data.models || []).map((m) => {
      const sizeGb = +(m.size / (1024 * 1024 * 1024)).toFixed(1);
      /* a model "fits" if it fits the FREE VRAM with ~15% headroom;
         bigger models still work via partial offload but risk CUDA crashes */
      const fits = gpu.hasGpu ? sizeGb <= Math.max(0.5, gpu.freeGb * 0.85) : true;
      return {
        name: m.name,
        size: m.size,
        sizeGb,
        fits,
        gpuNote: gpu.hasGpu
          ? (fits
              ? `fits your GPU (${sizeGb} GB ≤ ${gpu.freeGb} GB free)`
              : `${sizeGb} GB model vs ${gpu.freeGb} GB free VRAM — partial CPU offload, crash risk. Use CPU mode.`)
          : 'no NVIDIA GPU detected — CPU only',
        contextLength: m.details && m.details.context_length ? m.details.context_length : (m.context_length || 32768),
      };
    });
    return sendJson(res, 200, { running: true, models, gpu });
  } catch {
    return sendJson(res, 200, { running: false, models: [], gpu: detectGPU() });
  }
}

/* ---------------- /api/yt-meta (YouTube link unfurl for media cards) ----------------
   No API key needed — YouTube's public oEmbed endpoint returns the title and
   author for any watch/short link. We keep the last results cached so opening
   a link twice never re-hits the network. The thumbnail always comes from
   YouTube's own i.ytimg.com CDN (highest resolution available). */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ytMetaCache = new Map();

async function handleYtMeta(res, videoId) {
  const id = String(videoId || '').trim();
  if (!YT_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid YouTube video id' });
  if (ytMetaCache.has(id)) return sendJson(res, 200, ytMetaCache.get(id));

  const meta = { id, title: '', author: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  try {
    const oembedUrl =
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const r = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 JOI-Holographic-Companion' },
    });
    if (r.ok) {
      const j = await r.json();
      meta.title = String(j.title || '');
      meta.author = String(j.author_name || '');
    }
  } catch { /* offline → thumbnail-only card */ }
  ytMetaCache.set(id, meta);
  return sendJson(res, 200, meta);
}

/* ---------------- /api/latest-release (in-app update banner) ----------------
   Proxies the GitHub Releases API so the app can show "Update available —
   vX.Y.Z" on boot without CORS or API-key hassles (works in the browser AND
   inside the packaged EXE). Cached for 10 minutes so a boot storm never
   hammers GitHub. */
const GH_REPO = 'nobody71004/joi-companion';
let releaseCache = { at: 0, data: null };

async function handleLatestRelease(res) {
  if (releaseCache.data && Date.now() - releaseCache.at < 10 * 60 * 1000) {
    return sendJson(res, 200, releaseCache.data);
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'JOI-Holographic-Companion',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!r.ok) return sendJson(res, 502, { error: 'GitHub unreachable (' + r.status + ')' });
    const j = await r.json();
    const data = {
      tag: String(j.tag_name || ''),
      name: String(j.name || ''),
      url: String(j.html_url || `https://github.com/${GH_REPO}/releases/latest`),
      published_at: String(j.published_at || ''),
      assets: (j.assets || [])
        .filter((a) => /(exe|zip|msi|dmg|appimage|tar|gz)/i.test(String(a.name || '')))
        .map((a) => ({ name: String(a.name || ''), url: String(a.browser_download_url || ''), size: Number(a.size) || 0 })),
    };
    releaseCache = { at: Date.now(), data };
    return sendJson(res, 200, data);
  } catch {
    return sendJson(res, 502, { error: 'GitHub unreachable' });
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
  const isOllama = provider === 'ollama';
  const forceCPU = !!(body.forceCPU && isOllama);
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
    cfg.bodyObj = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.text })),
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    /* num_gpu: 0 forces CPU-only inference — the crash-proof mode for
       models bigger than your VRAM (no CUDA init, no 0xc0000409 crash). */
    if (forceCPU) cfg.bodyObj.options = { num_gpu: 0 };
    cfg.body = JSON.stringify(cfg.bodyObj);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  /* Cancel upstream generation when the client disconnects (real Stop). */
  const ctl = new AbortController();
  res.on('close', () => { try { ctl.abort(); } catch {} });

  /* ---- GPU-crash auto-recovery ----
     If Ollama's backend dies (llama-server terminated / CUDA init failed /
     stack-buffer overrun — the 0xc0000409 crash), retry the SAME request once
     with num_gpu: 0 (pure CPU). No restart needed: num_gpu is per-request. */
  const CRASH_RE = /llama-server|CUDA|0xc0000409|stack-based|overrun|shared object initialization|out of memory/i;

  let upstream = null;
  let usedCPU = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        /* second chance: force CPU for ollama only */
        if (!isOllama) break;
        cfg.bodyObj = Object.assign({}, cfg.bodyObj, { options: { num_gpu: 0 } });
        cfg.body = JSON.stringify(cfg.bodyObj);
        usedCPU = true;
      }

      upstream = await fetch(cfg.url, {
        method: 'POST',
        headers: cfg.headers,
        body: cfg.body,
        signal: AbortSignal.any([AbortSignal.timeout(300000), ctl.signal]),
      });

      if (upstream.ok) break;

      /* pull the error detail and decide whether this was a GPU crash */
      let detail = '';
      try {
        const j = await upstream.json();
        detail = j.error?.message || j.error || JSON.stringify(j).slice(0, 300);
      } catch {
        detail = (await upstream.text()).slice(0, 300);
      }
      if (attempt === 0 && CRASH_RE.test(detail)) continue; // retry in CPU mode

      res.write(`data: ${JSON.stringify({ error: `Provider error (${upstream.status}): ${detail}` })}\n\n`);
      res.end();
      return;
    }

    if (usedCPU) {
      /* let the client know the reply is running on CPU (slower, stable) */
      res.write(`data: ${JSON.stringify({ notice: 'GPU load failed — running this reply in CPU mode (stable, a bit slower).' })}\n\n`);
    }

    let sawDone = false;
    for await (const chunk of cfg.transform(upstream.body)) {
      if (res.destroyed || res.writableEnded) break;
      res.write(chunk);
      if (typeof chunk === 'string' && chunk.includes('[DONE]')) sawDone = true;
    }
    if (!res.destroyed && !res.writableEnded) {
      /* Upstream ended without its [DONE] marker → the generation was cut
         off mid-stream (the llama-server process crashed under a too-big
         model, or the connection died). Don't let that masquerade as a
         complete answer — send a notice the client shows in the bubble. */
      if (isOllama && !sawDone) {
        res.write(`data: ${JSON.stringify({ notice: 'Her reply was cut off — the model process ended mid-generation. Enable CPU mode in Settings, or pick a smaller model, to keep her stable.' })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    }
  } catch (err) {
    if (res.destroyed || res.writableEnded) return; // client already stopped us
    const abrupt = /terminated|fetch failed|ECONNRESET|socket hang|aborted|reset by peer/i.test(String(err.message || err));
    const msg =
      err.name === 'TimeoutError'
        ? 'The model took too long to respond. For Ollama, the first reply can take a while when a big model is cold-loading — try again now that it is warm, or pick the smaller model in Settings.'
        : (abrupt && isOllama)
          ? 'Her reply was cut off — the model process ended mid-generation. Enable CPU mode in Settings, or pick a smaller model, to keep her stable.'
          : `Could not reach ${base}. Is the provider running? (${err.message})`;
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  }
  try { res.end(); } catch {}
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
      /* packaged layout: <app>/resources/app.asar AND <app>/resources/venv —
         the venv is a SIBLING of app.asar inside resources/, so climb exactly
         ONE level from app.getAppPath(). (path.resolve normalizes so we can
         join robustly even when getAppPath is a .asar path.) */
      const base = app.getAppPath(); // packaged: ...\\resources\\app.asar
      const resDir = path.resolve(base, '..'); // ...\\resources
      cands.push(path.join(resDir, 'venv', 'Scripts', 'python.exe'));
      cands.push(path.join(resDir, 'venv', 'bin', 'python3'));
    } catch { /* ignore */ }
  }
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return process.platform === 'win32'
    ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'venv', 'bin', 'python3');
}
const PY = findPython();
/* If the venv can't be found (fresh clone, EXE missing bundled resources),
   log once at boot so voice problems are diagnosable. */
if (!fs.existsSync(PY)) {
  console.log('  ⚠ TTS engine (python venv) not found at ' + PY);
}

const TTS_VOICES = {
  /* female — JOI's voices */
  'en-US-MichelleNeural': 'Friendly (default)',
  'en-US-JennyNeural': 'Warm & gentle',
  'en-US-AriaNeural': 'Confident',
  'en-US-AnaNeural': 'Soft & intimate',
  'en-US-AvaNeural': 'Caring & expressive',
  'en-US-EmmaNeural': 'Cheerful & clear',
  'en-GB-LibbyNeural': 'British & sweet',
  'en-GB-SoniaNeural': 'British & warm',
  'en-GB-MaisieNeural': 'British & bright',
  'en-AU-NatashaNeural': 'Australian',
  'en-CA-ClaraNeural': 'Canadian',
  'en-IE-EmilyNeural': 'Irish',
  /* male — DELAMAIN's voices */
  'en-GB-RyanNeural': 'Ryan — British & refined (DELAMAIN)',
  'en-GB-ThomasNeural': 'Thomas — British & steady',
  'en-US-GuyNeural': 'Guy — US & conversational',
  'en-US-ChristopherNeural': 'Christopher — US & deep',
  'en-US-EricNeural': 'Eric — US & cool',
  'en-AU-WilliamNeural': 'William — Australian',
  'en-CA-LiamNeural': 'Liam — Canadian',
  'en-IE-ConnorNeural': 'Connor — Irish',
};

const TTS_SETUP_HINT = 'cd joi-companion && python -m venv venv && venv/Scripts/python.exe -m pip install edge-tts';

/* ---------------- /api/voice (offline mic input, no cloud) ----------------
   One-shot winmm capture + Windows System.Speech dictation. The Web Speech
   API needs Google's cloud (fails with 'network' in the EXE / restricted
   networks), so the 🎤 button routes here instead — fully local + offline.
   The script is spawned fresh per request and writes its result JSON to a
   temp file; packaged EXE keeps the script next to the executable. */
function findVoiceScript() {
  const cands = [
    path.join(__dirname, 'voice_capture.ps1'),
    path.join(__dirname, '..', 'resources', 'voice_capture.ps1'),
  ];
  if (IS_ELECTRON) {
    try {
      const { app } = require('electron');
      const resDir = path.resolve(app.getAppPath(), '..'); // ...\\resources
      cands.push(path.join(resDir, 'voice_capture.ps1'));
      cands.push(path.join(app.getPath('userData'), 'voice_capture.ps1'));
    } catch { /* ignore */ }
  }
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return process.platform === 'win32'
    ? path.join(__dirname, 'voice_capture.ps1')
    : '';
}
const VOICE_PS1 = findVoiceScript();
if (!VOICE_PS1 || !fs.existsSync(VOICE_PS1)) {
  console.log('  ⚠ voice input script not found; 🎤 will fall back to Web Speech');
}

async function handleVoice(req, res) {
  if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: 'Voice input needs Windows' });
  if (!VOICE_PS1 || !fs.existsSync(VOICE_PS1)) return sendJson(res, 501, { ok: false, error: 'voice_capture.ps1 not found' });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
  const seconds = Math.max(1, Math.min(10, parseInt(body.seconds, 10) || 4));
  const outJson = path.join(require('os').tmpdir(), 'joi_voice_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.json');
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VOICE_PS1,
    '-Seconds', String(seconds), '-OutJson', outJson,
  ], { windowsHide: true });
  const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, (seconds + 20) * 1000);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => {
    clearTimeout(killTimer);
    return sendJson(res, 500, { ok: false, error: 'voice: ' + err.message });
  });
  child.on('close', (code) => {
    clearTimeout(killTimer);
    try {
      /* Set-Content -Encoding UTF8 writes a BOM — strip it before parsing */
      const raw = fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '');
      const result = JSON.parse(raw);
      fs.unlinkSync(outJson);
      return sendJson(res, 200, result);
    } catch {
      return sendJson(res, 200, { ok: false, error: 'voice capture failed' + (stderr ? ': ' + stderr.slice(0, 200) : '') });
    }
  });
}

async function handleTTS(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
  const text = String(body.text || '').slice(0, 2000);
  const voice = TTS_VOICES[body.voice] ? body.voice : 'en-US-MichelleNeural';
  if (!text.trim()) return sendJson(res, 400, { error: 'No text to speak' });

  /* Pre-check the engine so we never send a 200 that turns out empty. */
  if (!fs.existsSync(PY)) {
    return sendJson(res, 501, { error: 'TTS engine not set up. Run: ' + TTS_SETUP_HINT });
  }

  const child = spawn(PY, [
    '-m', 'edge_tts', '--voice', voice,
    '--rate=-6%', '--pitch=+5Hz',
    '--text', text, '--write-media', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let gotBytes = false;
  let headersSent = false;
  const fail = () => {
    /* engine dead → never leave the client with a silent 200; destroying
       the socket makes the client fall back to a browser voice. */
    try { res.destroy(); } catch {}
  };

  child.on('error', () => {
    if (!headersSent) return sendJson(res, 501, { error: 'TTS engine not set up. Run: ' + TTS_SETUP_HINT });
    fail();
  });

  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  headersSent = true;
  child.stdout.on('data', () => { gotBytes = true; });
  child.stdout.pipe(res);
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (!gotBytes) { fail(); return; } /* zero output → not real audio */
    try { res.end(); } catch {}
  });
}

/* ---------------- second brain (long-term memory) ----------------
   Persistent server-side memory in data/memory.json — survives browser
   resets and server restarts. The client syncs name, facts and episodic
   memories here so JOI can "remember everything" across sessions. */
const DATA_DIR = path.join(packagedBase(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const MAX_MEMORIES = 400;

/* How many streaming replies are in flight right now. The sync/push script
   reads this via /api/state so it never force-kills the app mid-conversation
   (the reply + chat state would be lost). */
let activeStreams = 0;
function trackStream(res) {
  activeStreams++;
  let done = false;
  /* finish (handed to OS) and close (connection torn down) can BOTH fire for
     one response — guard so the counter is only ever decremented once, or the
     sync script could see a false "idle" (force-kill mid-reply) or a stuck
     "busy" (abort every rebuild). */
  const off = () => {
    if (done) return;
    done = true;
    activeStreams = Math.max(0, activeStreams - 1);
  };
  res.on('close', off);
  res.on('finish', off);
}

/* The visible conversation, persisted server-side so a restart/rebuild
   restores her context. The client pushes this after every exchange
   (debounced) and pulls it back on boot. Private — lives next to the
   brain in data/, never committed. */
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY = 60;
let savedHistory = [];
function loadHistory() {
  try {
    const d = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(d)) savedHistory = d.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-MAX_HISTORY);
  } catch { /* first run */ }
}
function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(savedHistory.slice(-MAX_HISTORY), null, 2));
  } catch (err) {
    console.error('  ✖ could not write history file:', err.message);
  }
}

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
loadHistory();

/* ---------------- /api/state (used by the sync script) ----------------
   Lets the sync/push pipeline ask "is she mid-reply?" before it rebuilds
   the EXE, so it can wait or abort instead of force-killing a live reply.
   Also exposes the version so the script can show what's running. */
function currentVersion() {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
}
function handleState(res) {
  sendJson(res, 200, { up: true, activeStreams, version: currentVersion() });
}

/* ---------------- /api/history (visible chat, persisted) ----------------
   The client pushes the rendered conversation here after every exchange
   (debounced) and pulls it back on boot, so a rebuild/restart restores her
   context instead of starting from a blank page. */
function handleHistoryGet(res) {
  sendJson(res, 200, savedHistory);
}
function handleHistorySet(req, res) {
  readBody(req).then((body) => {
    try {
      const arr = JSON.parse(body);
      if (!Array.isArray(arr)) throw new Error('not an array');
      savedHistory = arr
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
        .slice(-MAX_HISTORY);
      saveHistory();
      sendJson(res, 200, { ok: true, count: savedHistory.length });
    } catch {
      sendJson(res, 400, { error: 'Invalid history payload' });
    }
  }).catch(() => sendJson(res, 400, { error: 'Bad request' }));
}

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

/* ---------------- /api/delamain (in-game agent, SSE) ----------------
   Runs the DELAMAIN agent loop (same core as cyber-agent/agent.py) against
   your local Ollama and streams it back in the app's SSE shape so the face
   UI can reuse its whole pipeline — thinking bubble, tool-call events,
   streaming reply, lip-synced speech, Pause/Stop.
     data: {tool:{name,args,ok,result|error}}            per tool executed
     data: {choices:[{delta:{content}}]}                 the reply, streamed
     data: [DONE]
   body: { goal, model, backend: 'game'|'sim' } */
async function handleDelamain(req, res) {
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  const model = String(body.model || '').trim();
  const goal = String(body.goal || '').trim();
  if (!goal) return sendJson(res, 400, { error: 'No goal to execute.' });
  if (!model) return sendJson(res, 400, { error: 'No model selected. Pick a model in Settings first.' });

  const backend = body.backend === 'game' ? new delamain.GameBridge(DELAMAIN_IPC) : new delamain.SimBackend();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const ctl = new AbortController();
  res.on('close', () => { try { ctl.abort(); } catch {} });

  try {
    const { answer } = await delamain.agentTurn(model, backend, goal, {
      signal: ctl.signal,
      onTool: (fn, args, result) => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ tool: { name: fn, args, ok: !!result.ok, result: result.result, error: result.error } })}\n\n`);
      },
    });
    if (res.destroyed || res.writableEnded) return;
    /* stream the final reply in small chunks so the client renders + starts
       speaking almost immediately (same feel as the streaming /api/chat) */
    const chunks = String(answer || '').match(/[\s\S]{1,48}/g) || [];
    for (const c of chunks) {
      if (res.destroyed || res.writableEnded) break;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 16));
    }
    if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    const raw = String(err.message || err);
    const stopped = /abort/i.test(raw);
    const msg = stopped
      ? 'Stopped.'
      : (err.name === 'TimeoutError'
          ? 'DELAMAIN took too long to respond. The first reply can be slow while a big model cold-loads — try again now that it is warm, or pick a smaller model.'
          : (raw.includes('Ollama error') || /ECONNREFUSED|fetch failed/i.test(raw)
              ? 'Could not reach Ollama at 127.0.0.1:11434. Is it running? (ollama serve)'
              : 'DELAMAIN error: ' + raw));
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  }
  try { res.end(); } catch {}
}

/* ---------------- /api/delamain/state (game-link indicator) ----------------
   Reports whether the DELAMAIN CET mod bridge is live (fresh ipc/state.json)
   plus the latest snapshot — the client shows GAME LIVE / GAME OFFLINE. */
async function handleDelamainState(res) {
  const bridge = new delamain.GameBridge(DELAMAIN_IPC);
  const connected = bridge.connected();
  const state = connected ? bridge.readState() : null;
  sendJson(res, 200, { connected, state, ipc: DELAMAIN_IPC });
}

/* ---------------- server ---------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/api/delamain') return handleDelamain(req, res);
  if (req.method === 'GET' && url.pathname === '/api/delamain/state') return handleDelamainState(res);
  if (req.method === 'GET' && url.pathname === '/api/models') return handleModels(res);
  if (req.method === 'GET' && url.pathname === '/api/state') return handleState(res);
  if (req.method === 'GET' && url.pathname === '/api/history') return handleHistoryGet(res);
  if (req.method === 'POST' && url.pathname === '/api/history') return handleHistorySet(req, res);
  if (req.method === 'GET' && url.pathname === '/api/memory') return handleMemoryGet(res);
  if (req.method === 'POST' && url.pathname === '/api/memory') return handleMemorySet(req, res);
  if (req.method === 'POST' && url.pathname === '/api/memory/clear') return handleMemoryClear(res);
  if (req.method === 'GET' && url.pathname === '/api/audio-clips') return handleAudioClips(res);
  if (req.method === 'GET' && url.pathname === '/api/yt-meta') return handleYtMeta(res, url.searchParams.get('v'));
  if (req.method === 'GET' && url.pathname === '/api/latest-release') return handleLatestRelease(res);
  if (req.method === 'POST' && url.pathname === '/api/tts') return handleTTS(req, res);
  if (req.method === 'POST' && url.pathname === '/api/voice') return handleVoice(req, res);
  if (req.method === 'POST' && url.pathname === '/api/server/stop') return handleServerStop(res);
  if (req.method === 'POST' && url.pathname === '/api/server/restart') return handleServerRestart(res);
  if (req.method === 'POST' && url.pathname === '/api/server/start') return handleServerStart(res);
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT });
  if (req.method === 'GET' && url.pathname === '/api/version') {
    return sendJson(res, 200, { version: currentVersion() });
  }
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
