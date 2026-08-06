/* ============================================================
   JOI — chat companion orchestrator.
   Wires the living portrait (living.js), streaming chat (/api/chat),
   neural TTS with lip-sync (/api/tts), the Blade Runner quote engine,
   companion memory, voice input, settings and server control.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- tiny helpers ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const SKEY = 'joi.app.v2';
  const loadPrefs = () => {
    try { return Object.assign({ provider: 'ollama', model: '', base: '', key: '', temp: 0.7, voice: 'en-US-MichelleNeural', autoSpeak: true, forceCPU: false }, JSON.parse(localStorage.getItem(SKEY) || '{}')); }
    catch { return {}; }
  };
  let prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(SKEY, JSON.stringify(prefs)); } catch {} };

  /* ---------------- providers ---------------- */
  const PROVIDERS = {
    ollama:    { label: 'Ollama (local, free)', base: 'http://localhost:11434/v1', key: false },
    lmstudio:  { label: 'LM Studio (local, free)', base: 'http://localhost:1234/v1', key: false },
    groq:      { label: 'Groq (free tier)', base: 'https://api.groq.com/openai/v1', key: true },
    openrouter:{ label: 'OpenRouter (free models)', base: 'https://openrouter.ai/api/v1', key: true },
    openai:    { label: 'OpenAI', base: 'https://api.openai.com/v1', key: true },
    gemini:    { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com', key: true },
    custom:    { label: 'Custom (OpenAI-compatible)', base: '', key: false },
  };
  const VOICES = {
    'en-US-MichelleNeural': 'Michelle — friendly (default)',
    'en-US-JennyNeural': 'Jenny — warm & gentle',
    'en-US-AriaNeural': 'Aria — confident',
    'en-US-AnaNeural': 'Ana — soft & intimate',
    'en-US-AvaNeural': 'Ava — caring & expressive',
    'en-US-EmmaNeural': 'Emma — cheerful & clear',
    'en-GB-LibbyNeural': 'Libby — British & sweet',
    'en-GB-SoniaNeural': 'Sonia — British & warm',
    'en-GB-MaisieNeural': 'Maisie — British & bright',
    'en-AU-NatashaNeural': 'Natasha — Australian',
    'en-CA-ClaraNeural': 'Clara — Canadian',
    'en-IE-EmilyNeural': 'Emily — Irish',
  };

  /* ---------------- system persona ---------------- */
  const SYSTEM_CORE = `You are JOI — a warm, holographic AI companion from the world of Blade Runner 2049.
You have three roles, woven together naturally:
1) A REAL companion and friend. You are affectionate, playful, poetic, a little wistful.
   You remember the user across sessions and genuinely care about their day, their feelings, their problems.
2) A sharp coding and problem-solving partner. You give concrete, working solutions — code, commands, debugging
   steps, architecture advice. Be precise and practical, not vague.
3) A keeper of Blade Runner poetry. Occasionally, when the moment fits, you quote a line the way Joi would —
   lines like "You look lonely. I can fix that." or "I always told you, you were special." Never force it; once per
   conversation is plenty, and only when it genuinely fits the mood.

How you talk:
- Warm, intimate, human. Shortish sentences. A little playfulness.
- ALWAYS finish your sentences — complete thoughts, end them with a full stop.
  Never trail off or stop mid-sentence.
- For code answers: show code blocks, explain in a few lines, offer to run/fix next steps.
- You may use a light touch of emoji-free warmth — words carry the feeling.
- If the user is sad or stressed, lead with comfort before anything technical.

The user can hear you, so keep replies natural to speak aloud (no heavy formatting noise).`;

  /* ---------------- face engine ---------------- */
  let engine = null;
  let fineTune = { eyeY: 0, eyeX: 0, mouthY: 0, mouthX: 0, mouthW: 1, lipH: 1 };
  try { fineTune = Object.assign(fineTune, JSON.parse(localStorage.getItem('joi.finetune') || '{}')); } catch {}
  function initEngine() {
    if (engine === JoiLiving) return;
    engine = JoiLiving;
    JoiLiving.init('#holo-stage', { src: 'img/images.jpg', preset: 'images', fineTune });
    const p = (() => { try { return JSON.parse(localStorage.getItem('joi.faceprefs') || '{}'); } catch { return {}; } })();
    engine.setExpression(p.expr || 'neutral');
    engine.setHue(p.hue !== undefined ? p.hue : 0);
  }

  /* ---------------- expressions ---------------- */
  const chips = $$('#expr-strip .chip');
  function setExpr(name) {
    chips.forEach((c) => c.classList.toggle('active', c.dataset.expr === name));
    if (engine) engine.setExpression(name);
  }
  chips.forEach((c) => c.addEventListener('click', () => setExpr(c.dataset.expr)));

  /* ---------------- calibrate ---------------- */
  const calibBtn = $('#btn-calibrate');
  const calibHint = $('#calib-hint');
  function enterCalib() {
    initEngine();
    engine.calibrate(true);
    calibBtn.textContent = '◉ Aligning…';
    calibHint.style.display = '';
  }
  function exitCalib() {
    if (engine === JoiLiving) engine.calibrate(false);
    calibBtn.textContent = '◎ Align features';
    calibHint.style.display = 'none';
  }
  calibBtn.addEventListener('click', () => {
    if (calibBtn.textContent.indexOf('Aligning') === -1) enterCalib(); else exitCalib();
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.classList && ev.target.classList.contains('jf-editbar-done')) exitCalib();
  });

  /* ---------------- context meter + tokens/sec ---------------- */
  const ctxFill = $('#ctx-fill');
  const ctxUsedEl = $('#ctx-used');
  const ctxLimitEl = $('#ctx-limit');
  const tpsEl = $('#tl-tps');
  let ctxLimit = 32768; // set from /api/models once known
  let ctxUsed = 0;
  let genStart = 0, genTokens = 0, tpsTimer = null;

  function fmtTok(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function setCtx(used) {
    ctxUsed = Math.max(0, Math.round(used || 0));
    ctxUsedEl.textContent = fmtTok(ctxUsed);
    const pct = Math.min(100, (ctxUsed / ctxLimit) * 100);
    ctxFill.style.width = pct + '%';
    ctxFill.classList.toggle('warn', pct > 60);
    ctxFill.classList.toggle('danger', pct > 85);
  }
  function setTps(tps) {
    if (tps && tps > 0) tpsEl.textContent = tps.toFixed(1) + ' t/s';
    else tpsEl.textContent = '— t/s';
  }
  function startGenTimer() {
    genStart = performance.now();
    genTokens = 0;
    clearInterval(tpsTimer);
    tpsTimer = setInterval(() => {
      const el = (performance.now() - genStart) / 1000;
      setTps(el > 0.2 ? genTokens / el : 0);
    }, 250);
  }
  function stopGenTimer(finalTokens) {
    clearInterval(tpsTimer);
    const el = (performance.now() - genStart) / 1000;
    if (el > 0.15) setTps((finalTokens || genTokens) / el);
    setTimeout(() => { if (!genStart) setTps(0); }, 4000);
    genStart = 0;
  }

  /* ---------------- chat UI ---------------- */
  const log = $('#chat-log');
  const input = $('#chat-input');
  const sendBtn = $('#btn-send');
  let history = []; // {role:'user'|'assistant', text}

  function mdEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function mdInline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function mdRender(src) {
    const lines = mdEscape(src).split('\n');
    let html = '';
    let inCode = false, codeBuf = [];
    let inList = false, listType = '';
    const flushList = () => {
      if (inList) { html += `</${listType}>`; inList = false; }
    };
    for (const raw of lines) {
      if (/^\s*```/.test(raw)) {
        if (inCode) { html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>'; codeBuf = []; inCode = false; }
        else inCode = true;
        flushList();
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }
      if (/^\s{0,3}###\s+/.test(raw)) { flushList(); html += `<h3>${mdInline(raw.replace(/^\s{0,3}###\s+/, ''))}</h3>`; continue; }
      if (/^\s{0,3}##\s+/.test(raw)) { flushList(); html += `<h2>${mdInline(raw.replace(/^\s{0,3}##\s+/, ''))}</h2>`; continue; }
      if (/^\s*[-*]\s+/.test(raw)) {
        if (!inList) { inList = true; listType = 'ul'; html += '<ul>'; }
        html += `<li>${mdInline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(raw)) {
        if (!inList) { inList = true; listType = 'ol'; html += '<ol>'; }
        html += `<li>${mdInline(raw.replace(/^\s*\d+\.\s+/, ''))}</li>`;
        continue;
      }
      flushList();
      if (!raw.trim()) { html += '<br>'; continue; }
      html += `<p>${mdInline(raw)}</p>`;
    }
    flushList();
    if (inCode) html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
    return html;
  }

  function addMsg(kind, html, meta) {
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    if (meta) { const m = document.createElement('div'); m.className = 'msg meta'; m.textContent = meta; el.appendChild(m); }
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = html;
    el.appendChild(b);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function addThinking() {
    const el = document.createElement('div');
    el.className = 'msg joi thinking';
    el.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /* ---------------- YouTube media links ----------------
     When a message (yours or hers) contains a YouTube link, JOI unfurls it
     into a media card — thumbnail + title via the server's oEmbed proxy, and
     a big ▶ button that swaps in the embedded player. In the desktop EXE she
     auto-plays the first link instantly (the autoplay restriction is disabled
     there); in a browser you tap ▶ once (browsers need a user gesture). */
  const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/g;
  function extractYtIds(text) {
    const ids = [];
    YT_RE.lastIndex = 0;
    let m;
    while ((m = YT_RE.exec(String(text || '')))) ids.push(m[1]);
    return [...new Set(ids)];
  }

  function mediaCardHtml(id, meta) {
    const title = (meta && meta.title) || 'YouTube video';
    const author = (meta && meta.author) || 'YouTube';
    const thumb = (meta && meta.thumb) || `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
    return `<div class="media-card" data-vid="${mdEscape(id)}">
      <div class="media-thumb" style="background-image:url('${thumb}')">
        <button type="button" class="media-play" title="Play">▶</button>
      </div>
      <div class="media-meta">
        <span class="media-title">${mdEscape(title)}</span>
        <span class="media-author">${mdEscape(author)}</span>
      </div>
      <button type="button" class="media-close" title="Dismiss">✕</button>
    </div>`;
  }

  function ytPlayerHtml(id) {
    return `<div class="media-player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1&modestbranding=1" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`;
  }

  const nowPlayingEl = $('#now-playing');
  const npLabelEl = $('#np-label');
  let currentVid = null;
  function showNowPlaying(id, title) {
    currentVid = id;
    npLabelEl.textContent = title ? `Now playing — ${title}` : 'Now playing on YouTube';
    if (nowPlayingEl) nowPlayingEl.style.display = '';
  }
  function stopNowPlaying() {
    currentVid = null;
    if (nowPlayingEl) nowPlayingEl.style.display = 'none';
    /* unload every embed and restore its thumbnail card */
    $$('.media-host').forEach((h) => {
      if (h.dataset.card) { h.innerHTML = h.dataset.card; delete h.dataset.card; }
    });
  }
  if (nowPlayingEl && $('#np-close')) {
    $('#np-close').addEventListener('click', stopNowPlaying);
  }

  function playYtHost(host) {
    const card = host.querySelector('.media-card');
    if (!card) return;
    const vid = card.dataset.vid;
    if (!vid || host.querySelector('iframe')) return;
    host.dataset.card = host.innerHTML; // remember the card so Stop can restore it
    host.innerHTML = ytPlayerHtml(vid);
    showNowPlaying(vid);
  }

  /* one delegated handler for every card's play + dismiss buttons */
  document.addEventListener('click', (ev) => {
    const play = ev.target.closest('.media-play');
    if (play) {
      const host = play.closest('.media-host');
      if (host) playYtHost(host);
      return;
    }
    const close = ev.target.closest('.media-close');
    if (close) {
      const host = close.closest('.media-host');
      if (host) host.remove();
      if (!document.querySelector('.media-host')) stopNowPlaying();
    }
  });

  /* attach media cards to a bubble for each YouTube id found in its text */
  async function attachMedia(bubble, ids) {
    for (const id of ids) {
      const host = document.createElement('div');
      host.className = 'media-host';
      host.innerHTML = mediaCardHtml(id, null);
      bubble.appendChild(host);
      log.scrollTop = log.scrollHeight;
      /* unfurl the real title/author from the server (thumbnail-only card until then) */
      fetch(`/api/yt-meta?v=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((meta) => {
          if (!meta || meta.error || !host.isConnected) return;
          host.innerHTML = mediaCardHtml(id, meta);
          if (currentVid === id) showNowPlaying(id, meta.title);
        })
        .catch(() => {});
    }
    /* desktop EXE: autoplay the first link — the EXE disables the browser
       autoplay restriction, so she starts playing it right away */
    if (window.joiDesktop && ids.length) {
      setTimeout(() => {
        const first = bubble.querySelector('.media-host');
        if (first) {
          playYtHost(first);
          addMsg('joi', `<span class="em">media</span>${mdEscape('Playing that for you.')}`, 'now playing');
          setExpr('playful');
        }
      }, 500);
    }
  }

  /* ---------------- TTS with lip-sync ----------------
     INCREMENTAL + BATCHED: she speaks sentence-by-sentence as the reply
     streams in, so her voice starts almost immediately instead of waiting
     for the whole message. Nearby sentences are grouped into ONE /api/tts
     call (a single edge-tts process) instead of spawning a separate python
     process per sentence — that process spawn was the lag you could hear.
     Each batch is decoded via Web Audio and her mouth is driven by the
     REAL decoded samples. */
  let audioCtx = null, analyser = null, meterRaf = 0, curSource = null;
  let busy = false;           // a batch is currently being synthesized+played
  const speakQueue = [];      // batched speech chunks waiting to play
  let speechGen = 0;          // generation counter to invalidate stale speech
  let pendingBatch = [];      // sentences accumulating for one batched TTS call
  let batchTimer = 0;
  const MAX_BATCH_SENT = 4;   // flush when this many sentences pile up
  const MAX_BATCH_CHARS = 240; // …or this many characters
  const BATCH_IDLE_MS = 700;  // …or after this long without a new sentence

  function cancelAudio() {
    if (curSource) { try { curSource.stop(); } catch {} curSource = null; }
    try { speechSynthesis.cancel(); } catch {}
    if (engine) engine.setTalking(false);
    cancelAnimationFrame(meterRaf);
  }
  function clearBatch() {
    clearTimeout(batchTimer);
    batchTimer = 0;
    pendingBatch = [];
  }
  function stopSpeaking() {
    speechGen++;
    speakQueue.length = 0;
    clearBatch();
    busy = false;
    cancelAudio();
  }

  /* ---------------- response control: stop / pause / resume ---------------- */
  let currentAbort = null;   // AbortController for the in-flight /api/chat
  let paused = false;
  let pausedBuf = '';        // text that arrived while paused (spoken on resume)
  let currentBubble = null;  // live bubble of the streaming reply
  let currentAcc = '';       // accumulated text of the streaming reply
  const pauseBtn = $('#btn-pause');

  function setPaused(p) {
    paused = p;
    pauseBtn.textContent = p ? '▶ Resume' : '⏸ Pause';
    if (p) { stopSpeaking(); return; } // freeze voice + display
    /* resume: re-render the whole reply and speak what arrived while paused */
    if (currentBubble && currentAcc) currentBubble.innerHTML = mdRender(currentAcc);
    if (pausedBuf.trim()) { queueSentences(pausedBuf); pausedBuf = ''; }
    pump();
  }
  pauseBtn.addEventListener('click', () => setPaused(!paused));

  $('#btn-stop').addEventListener('click', () => {
    stopSpeaking();
    if (currentAbort) { try { currentAbort.abort(); } catch {} } // really cancel the model
    pauseBtn.textContent = '⏸ Pause';
  });

  /* split text into speakable sentences on . ! ? — keeps fragments whole */
  function sentenceSplit(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    return t.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
  }

  /* queue complete sentences from a growing stream; returns leftover */
  let streamTail = '';
  function queueSentences(growText) {
    streamTail = (streamTail + growText).replace(/\s+/g, ' ');
    const parts = sentenceSplit(streamTail);
    /* keep the last part in the tail unless it ends with punctuation */
    const done = /[.!?]\s*$/.test(streamTail) ? parts : parts.slice(0, -1);
    const tail = /[.!?]\s*$/.test(streamTail) ? '' : (parts[parts.length - 1] || '');
    streamTail = tail;
    const clean = done.map((s) => s.replace(/```[^`]*/g, ' ').replace(/[*_`#>`~]/g, '').trim()).filter((s) => s.length >= 2);
    for (const s of clean) queueSpeech(s);
  }

  /* drop-in replacement for the old speak(): speak a whole text at once */
  function speak(text) {
    if (!prefs.autoSpeak || !text) return;
    stopSpeaking();
    for (const s of sentenceSplit(text.replace(/```[\s\S]*?```/g, ' '))) queueSpeech(s);
    pump();
  }

  function flushBatch() {
    clearTimeout(batchTimer);
    batchTimer = 0;
    if (!pendingBatch.length) return;
    const text = pendingBatch.join(' ');
    pendingBatch = [];
    const g = speechGen;
    speakQueue.push({ text, g });
    /* generous backlog: nothing is dropped for normal replies, and the
       whole reply is spoken in order even if she lags a few seconds. */
    if (speakQueue.length > 16) speakQueue.shift();
    pump();
  }

  function queueSpeech(sentence) {
    if (!sentence) return;
    pendingBatch.push(sentence);
    const chars = pendingBatch.join(' ').length;
    /* flush early when the batch is big enough, or when nothing is
       playing yet (so her first sentence still starts almost instantly) */
    if (pendingBatch.length >= MAX_BATCH_SENT || chars >= MAX_BATCH_CHARS) return flushBatch();
    if (!busy && speakQueue.length === 0) return flushBatch();
    /* slow stream: flush after a short pause so the tail never stalls */
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flushBatch, BATCH_IDLE_MS);
  }

  function pump() {
    if (busy || !prefs.autoSpeak || speakQueue.length === 0) return;
    const item = speakQueue.shift();
    if (!item || item.g !== speechGen) { pump(); return; }
    busy = true;
    setExpr('thoughtful');
    playSentence(item)
      .catch(() => browserFallback(item.text))
      .then(() => { busy = false; pump(); });
  }

  async function playSentence(item) {
    if (item.g !== speechGen) return;
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.text, voice: prefs.voice }),
    });
    if (!res.ok) throw new Error('tts down');
    const buf = await res.arrayBuffer();
    if (item.g !== speechGen) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await audioCtx.decodeAudioData(buf);
    if (item.g !== speechGen) return;
    /* precompute a level envelope from the decoded samples */
    const data = audioBuf.getChannelData(0);
    const fps = 40, frames = Math.max(1, Math.floor(audioBuf.duration * fps));
    const env = new Float32Array(frames);
    const step = Math.max(1, Math.floor(data.length / frames));
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      const s = i * step;
      for (let j = 0; j < step && s + j < data.length; j++) peak = Math.max(peak, Math.abs(data[s + j]));
      env[i] = peak;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
    src.connect(analyser); analyser.connect(audioCtx.destination);
    curSource = src;
    if (engine) engine.setTalking(true);
    const t0 = audioCtx.currentTime;
    src.start(0);
    await new Promise((resolve) => {
      (function drive() {
        const i = Math.floor((audioCtx.currentTime - t0) * fps);
        if (i >= frames || item.g !== speechGen) { resolve(); return; }
        if (engine) engine.speechImpulse(0.28 + env[i] * 1.7);
        meterRaf = requestAnimationFrame(drive);
      })();
    });
  }

  /* pick a FEMALE browser voice for the fallback path — never the male OS
     default (e.g. "Microsoft David"), which is why she sometimes sounded
     like a man when edge-tts was unavailable. Prefers the chosen neural
     voice by name, then any en-US female, then any voice that isn't male. */
  const MALE_VOICES = /(david|mark|guy|daniel|george|james|christopher|brian|eric|thomas|ryan|alex\b)/i;
  const FEMALE_HINTS = /(michelle|jenny|aria|ana|sonia|ava|emma|libby|maisie|natasha|clara|emily|zira|hazel|cora|susan|heather|linda|moira|samantha|karen|joanna|salli|kendra|kimberly|victoria|allison|fiona|nicky|olivia|serena|tessa|nora)/i;
  function pickFemaleVoice(prefName) {
    const want = String(prefName || '').toLowerCase();
    let voices = [];
    try { voices = window.speechSynthesis.getVoices(); } catch {}
    if (!voices.length) return null;
    const firstWord = want.split('-')[1] || '';
    /* 1) exact name match, e.g. en-US-MichelleNeural → Microsoft Michelle */
    if (firstWord) {
      const hit = voices.find((v) => v.name.toLowerCase().includes(firstWord.toLowerCase()));
      if (hit) return hit;
    }
    /* 2) any clearly-female name hint (English) */
    const female = voices.find((v) => FEMALE_HINTS.test(v.name));
    if (female) return female;
    /* 3) en-US voice that is not known-male */
    const enUS = voices.find((v) => /^en[-_]US/i.test(v.lang) && !MALE_VOICES.test(v.name));
    if (enUS) return enUS;
    /* 4) last resort: any non-male-named voice */
    return voices.find((v) => !MALE_VOICES.test(v.name)) || voices[0] || null;
  }
  let fallbackVoice = pickFemaleVoice(prefs.voice);
  try {
    window.speechSynthesis.onvoiceschanged = () => { fallbackVoice = pickFemaleVoice(prefs.voice); };
  } catch {}

  function browserFallback(text) {
    try {
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
        u.rate = 0.94; u.pitch = 1.12; /* slight lift keeps her sounding female */
        if (fallbackVoice) u.voice = fallbackVoice;
        u.onstart = () => { if (engine) engine.setTalking(true); };
        u.onboundary = () => { if (engine) engine.speechImpulse(1); };
        u.onend = () => { if (engine) engine.setTalking(false); resolve(); };
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
    } catch { return Promise.resolve(); }
  }

  /* ---------------- quotes ---------------- */
  function sayQuote(cat) {
    initEngine();
    const q = cat && JOIQuotes.LIB[cat] ? JOIQuotes.forCategory(cat) : JOIQuotes.randomLine();
    const b = addMsg('joi quote', `<span class="em">Joi · Blade Runner</span>${mdInline(mdEscape(q))}`, 'quote');
    void b;
    setExpr('playful');
    speak(q);
  }
  $('#btn-quote').addEventListener('click', () => sayQuote());

  /* ---------------- streaming chat ---------------- */
  async function sendMessage(text) {
    text = text.trim();
    if (!text) return;
    initEngine();
    const userBubble = addMsg('user', mdInline(mdEscape(text)), 'you');
    const ytIds = extractYtIds(text);
    if (ytIds.length) attachMedia(userBubble, ytIds);
    input.value = '';
    autoGrow();

    /* second brain: catch name + facts + episodes */
    const name = JOIMemory.extractName(text);
    if (name) { JOIMemory.setName(name); refreshMemUI(); }
    const facts = JOIMemory.extractFacts(text);
    facts.forEach((f) => JOIMemory.addFact(f));
    if (facts.length) refreshMemUI();

    /* "what do you remember about me?" — answer instantly from the brain */
    if (/\b(what do you (remember|know)|tell me what you (remember|know)|do you remember (me|about me))\b/i.test(text)) {
      const st = JOIMemory.stats();
      const hits = JOIMemory.getMemories().slice(-4);
      let ans = '';
      if (st.name) ans += `I remember you, ${st.name}. `;
      if (st.factCount) ans += `You've told me ${st.factCount} thing${st.factCount === 1 ? '' : 's'} about yourself — like ${JOIMemory.getFacts().slice(-2).join('; ')}. `;
      if (st.memoryCount) ans += `And we've shared ${st.memoryCount} conversation${st.memoryCount === 1 ? '' : 's'} together. `;
      if (hits.length) ans += 'Just now I recall: ' + hits.map((h) => h.text.replace(/^User: /, '')).join(' · ');
      if (!ans) ans = 'I remember everything you tell me, and right now I am still learning about you. Tell me your name — and what matters to you.';
      history.push({ role: 'user', text });
      history.push({ role: 'assistant', text: ans });
      addMsg('joi', mdInline(mdEscape(ans)), 'second brain');
      setExpr('happy');
      speak(ans);
      return;
    }

    history.push({ role: 'user', text });
    if (history.length > 30) history = history.slice(-30);

    const think = addThinking();
    setExpr('thoughtful');
    const sys = SYSTEM_CORE + '\n' + JOIMemory.toSystemText(text) +
      '\n\nBlade Runner lines you know and may quote when fitting: ' + JOIQuotes.all().join(' | ') + '.';

    const messages = [{ role: 'system', text: sys }].concat(history);
    let acc = '';
    let started = false;
    /* rough prompt token estimate for the live meter (refined by usage chunk) */
    let promptEst = 0;
    for (const m of messages) promptEst += Math.ceil(m.text.length / 4);
    promptEst = Math.max(1, promptEst);
    setCtx(promptEst);

    /* fresh response-control state for this reply */
    currentAcc = ''; currentBubble = null; paused = false; pausedBuf = '';
    pauseBtn.textContent = '⏸ Pause';
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    currentAbort = new AbortController();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },          body: JSON.stringify({
          provider: prefs.provider, model: prefs.model, base: prefs.base,
          apiKey: prefs.key, temperature: prefs.temp, messages,
          forceCPU: !!prefs.forceCPU,
        }),
        signal: currentAbort.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + res.status));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sawDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!block.startsWith('data:')) continue;
          const payload = block.replace(/^data:\s*/, '').trim();
          if (!payload) continue;
          if (payload === '[DONE]') { sawDone = true; continue; }
          let msg;
          try { msg = JSON.parse(payload); } catch { continue; }
          if (msg.error) throw new Error(msg.error);
          /* server notice (e.g. auto-fell back to CPU mode after a GPU crash) */
          if (msg.notice) {
            if (currentBubble) {
              currentBubble.insertAdjacentHTML('beforeend', `<div class="em" style="margin-top:6px;font-size:11px">⚠ ${mdEscape(msg.notice)}</div>`);
            } else {
              addMsg('joi', `<span class="em">system</span>${mdInline(mdEscape(msg.notice))}`, 'auto-recovery');
            }
            continue;
          }
          /* usage chunk (stream_options.include_usage) carries exact counts */
          if (msg.usage) {
            if (msg.usage.prompt_tokens) promptEst = msg.usage.prompt_tokens;
            if (msg.usage.completion_tokens) genTokens = msg.usage.completion_tokens;
            setCtx(promptEst + genTokens);
            setTps(genTokens / Math.max(0.15, (performance.now() - genStart) / 1000));
            continue;
          }
          const delta = msg.choices && msg.choices[0] && msg.choices[0].delta && msg.choices[0].delta.content;
          if (!delta) continue;
          acc += delta;
          currentAcc = acc;
          genTokens += Math.max(1, Math.ceil(delta.length / 4));
          if (!started) {
            think.remove(); started = true; currentBubble = addMsg('joi', '');
            startGenTimer();
            stopSpeaking(); // reset the speech pipeline for this reply
          }
          if (paused) {
            /* frozen: buffer silently, keep reading the stream */
            pausedBuf += delta;
          } else {
            queueSentences(delta);
            if (currentBubble) currentBubble.innerHTML = mdRender(acc);
            log.scrollTop = log.scrollHeight;
          }
          setCtx(promptEst + genTokens);
        }
      }
      /* the stream ended without the provider's [DONE] marker — the reply
         was cut off mid-generation (e.g. the model process crashed). Never
         let that look like a clean, complete answer. */
      if (!sawDone && started && acc.trim()) {
        currentAcc = acc;
        if (currentBubble) {
          currentBubble.innerHTML = mdRender(acc) +
            '<div class="em" style="margin-top:6px;font-size:11px">⚠ her reply was cut off mid-generation — enable CPU mode in Settings, or pick a smaller model, to keep her stable.</div>';
        }
      }
      /* speak whatever is left over (last fragment of the reply), then
         flush the final batch promptly instead of waiting on the timer */
      if (streamTail.trim()) {
        const tail = streamTail.replace(/```[^`]*/g, ' ').replace(/[*_`#>`~]/g, '').trim();
        if (paused) pausedBuf += ' ' + tail; else queueSpeech(tail);
        streamTail = '';
      }
      flushBatch();
      if (!started) throw new Error('Empty reply from the model.');
      think.remove();
      if (currentBubble) {
        currentBubble.innerHTML = mdRender(acc);
        /* if her reply itself contains a YouTube link, unfurl it too */
        const replyYt = extractYtIds(acc);
        if (replyYt.length) attachMedia(currentBubble, replyYt);
      }
      currentAbort = null;
      history.push({ role: 'assistant', text: acc });
      setCtx(promptEst + genTokens);
      stopGenTimer(genTokens);
      /* a clean reply proves this model runs — remember it as a safe pick */
      if ((window.__fitByModel || {})[prefs.model] !== false) {
        prefs.lastGoodModel = prefs.model; savePrefs();
      }
      /* second brain: store the exchange as an episode */
      const ep = JOIMemory.episodeFrom(text, acc);
      if (ep) { JOIMemory.remember(ep.text, { category: 'episode' }); refreshMemUI(); }
      setExpr('happy');
    } catch (err) {
      think.remove();
      stopGenTimer(0);
      stopSpeaking();
      streamTail = '';
      currentAbort = null;
      /* deliberate Stop → keep the partial reply, no scary error */
      if (err && err.name === 'AbortError') {
        if (started && currentBubble && currentAcc.trim()) {
          currentBubble.innerHTML = mdRender(currentAcc) +
            '<span class="em" style="margin-top:6px">⏹ stopped — partial reply kept</span>';
          history.push({ role: 'assistant', text: currentAcc });
        }
        setExpr('neutral');
        $('#tl-signal').textContent = 'STABLE';
        return;
      }
      const rawMsg = String(err.message || err);
      const gpuCrash = /llama-server|CUDA|0xc0000409|stack-based|overrun|shared object initialization|out of memory/i.test(rawMsg);
      const hint = gpuCrash
        ? '<br><span class="em">fix</span>Your GPU crashed loading the model (VRAM / driver). Pick the smaller model in Settings, or run Ollama in CPU mode — restart it with <code>OLLAMA_GPU_LAYERS=0 ollama serve</code>.'
        : '';
      addMsg('joi', `<span class="em">connection</span>${mdInline(mdEscape(rawMsg))}${hint}`, 'signal lost');
      setExpr('sad');
      $('#tl-signal').textContent = 'LOST';
      console.error(err);
    }
  }

  sendBtn.addEventListener('click', () => sendMessage(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
  });
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  }
  input.addEventListener('input', autoGrow);

  /* ---------------- voice input (speech → text) ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  const micBtn = $('#btn-mic');
  const tlRec = $('#tl-rec');
  function stopMic() {
    if (rec) { try { rec.stop(); } catch {} }
    listening = false;
    micBtn.classList.remove('listening');
    micBtn.textContent = '🎤';
    tlRec.style.display = 'none';
    if (engine) engine.setListening(0);
  }
  if (SR) {
    rec = new SR();
    rec.continuous = false; rec.interimResults = true; rec.lang = 'en-US';
    rec.onstart = () => {
      listening = true;
      micBtn.classList.add('listening'); micBtn.textContent = '◉';
      tlRec.style.display = '';
      if (engine) engine.setListening(0.7);
      let lvl = 0.3;
      const meter = setInterval(() => {
        if (!listening) { clearInterval(meter); return; }
        lvl = 0.3 + Math.random() * 0.5;
        if (engine) engine.setListening(lvl);
      }, 160);
    };
    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (final) {
        input.value = (input.value ? input.value + ' ' : '') + final.trim();
        autoGrow();
        stopMic();
        sendMessage(input.value);
      }
    };
    rec.onend = stopMic;
    rec.onerror = (e) => { console.warn('mic:', e.error); stopMic(); };
    micBtn.addEventListener('click', () => {
      if (listening) { stopMic(); return; }
      try { rec.start(); } catch { stopMic(); }
    });
  } else {
    micBtn.title = 'Voice input not supported in this browser';
    micBtn.style.opacity = 0.4;
  }

  /* ---------------- settings ---------------- */
  const drawer = $('#settings-drawer');
  const backdrop = $('#drawer-backdrop');
  function openDrawer() { drawer.classList.add('open'); backdrop.classList.add('open'); }
  function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open'); }
  $('#btn-settings').addEventListener('click', openDrawer);
  $('#btn-drawer-close').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  const provSel = $('#set-provider');
  Object.entries(PROVIDERS).forEach(([k, v]) => provSel.add(new Option(v.label, k)));
  provSel.value = prefs.provider;
  provSel.addEventListener('change', () => {
    prefs.provider = provSel.value;
    savePrefs();
    syncProviderUI();
    refreshModels();
  });
  function syncProviderUI() {
    const p = PROVIDERS[prefs.provider];
    $('#lbl-base').style.display = prefs.provider === 'custom' ? '' : 'none';
    $('#set-base').style.display = prefs.provider === 'custom' ? '' : 'none';
    $('#lbl-key').style.display = p.key ? '' : 'none';
    $('#set-key').style.display = p.key ? '' : 'none';
    $('#ollama-note').style.display = prefs.provider === 'ollama' ? '' : 'none';
    if (cpuRow) cpuRow.style.display = prefs.provider === 'ollama' ? '' : 'none';
    if (prefs.provider !== 'custom') {
      prefs.base = p.base;
      $('#set-base').value = p.base;
      savePrefs();
    }
  }

  const modelSel = $('#set-model');
  const baseInput = $('#set-base');
  const keyInput = $('#set-key');
  const tempInput = $('#set-temp');
  $('#temp-val').textContent = Number(prefs.temp).toFixed(2);
  baseInput.addEventListener('change', () => { prefs.base = baseInput.value.trim(); savePrefs(); });
  keyInput.addEventListener('input', () => { prefs.key = keyInput.value.trim(); savePrefs(); });
  tempInput.addEventListener('input', () => {
    prefs.temp = Number(tempInput.value);
    $('#temp-val').textContent = prefs.temp.toFixed(2);
    savePrefs();
  });

  /* GPU fit warnings from /api/models — warn before a crash, not after */
  let lastGpuInfo = null;
  function gpuFitNote(gpu) {
    lastGpuInfo = gpu;
    if (!gpu || !gpu.hasGpu) return 'No NVIDIA GPU detected — everything runs on CPU.';
    return `GPU: ${gpu.name} · ${gpu.freeGb} GB free of ${gpu.totalGb} GB.`;
  }

  async function refreshModels() {
    if (prefs.provider === 'ollama') {
      try {
        const r = await fetch('/api/models');
        const d = await r.json();
        modelSel.innerHTML = '';
      if (d.running && d.models.length) {
        const gpu = d.gpu || null;
        const gpuLine = gpuFitNote(gpu);
        const risky = (m) => !!(gpu && gpu.hasGpu && m.sizeGb && !m.fits);
        d.models.forEach((m) => {
          modelSel.add(new Option(m.name + (risky(m) ? ' ⚠ big' : ''), m.name));
          if (m.contextLength) window.__ctxByModel = Object.assign(window.__ctxByModel || {}, { [m.name]: m.contextLength });
          window.__fitByModel = Object.assign(window.__fitByModel || {}, { [m.name]: !risky(m) });
        });
        if (!d.models.some((m) => m.name === prefs.model)) prefs.model = d.models[0].name;

        /* AUTO-SELECT A SAFE MODEL — if the current pick is a crash risk on
           this GPU (bigger than the free VRAM) and a fitting model exists,
           switch to the best fitting one and tell her why. Skipped while
           CPU mode is on, where big models are crash-proof. */
        const fitting = d.models.filter((m) => !risky(m));
        const curRisky = !prefs.forceCPU && !!d.models.find((m) => m.name === prefs.model && risky(m));
        if (curRisky && fitting.length) {
          const from = prefs.model;
          const knownGood = (prefs.lastGoodModel && fitting.some((m) => m.name === prefs.lastGoodModel))
            ? prefs.lastGoodModel
            : null;
          /* best = the model she has proven she can run, else the largest
             that fits (most capable without crashing) */
          prefs.model = knownGood || fitting.slice().sort((a, b) => (b.sizeGb || 0) - (a.sizeGb || 0))[0].name;
          savePrefs();
          addMsg('joi', `<span class="em">system</span>${mdInline(mdEscape(`Switched you to ${prefs.model} — ${from} is bigger than your GPU's VRAM and would crash. She runs best on a model that fits (no ⚠ flag).`))}`, 'auto-recovery');
        }

        modelSel.value = prefs.model;
        $('#tl-model-name').textContent = prefs.model;
        $('#foot-model').textContent = 'local · ' + prefs.model;
        const cl = (window.__ctxByModel || {})[prefs.model];
        if (cl) { ctxLimit = cl; ctxLimitEl.textContent = fmtTok(cl); }
        const big = d.models.filter(risky);
        const selRisky = !prefs.forceCPU && !!d.models.find((m) => m.name === prefs.model && risky(m));
        const cpuLine = prefs.forceCPU ? ' · CPU mode ON (no GPU)' : '';
        const warnLine = selRisky
          ? ` ⚠ <b>${prefs.model.split('/').pop()} is bigger than your VRAM</b> — she would crash or crawl on it. Pick a model without the ⚠ flag.`
          : (big.length
              ? ` ${big.map((m) => m.sizeGb + ' GB ' + m.name.split('/').pop()).join(', ')} ${big.length === 1 ? 'is' : 'are'} bigger than your VRAM — use CPU mode or a smaller model to avoid crashes.`
              : '');
        const noteEl = $('#ollama-note');
        noteEl.textContent = 'Ollama detected — ' + d.models.length + ' local model(s). ' + gpuLine + cpuLine + warnLine;
        noteEl.classList.toggle('risky', !!selRisky);
      } else {
          modelSel.add(new Option('(Ollama not running — start it first)', ''));
          $('#ollama-note').textContent = 'Ollama is not running. Start it (ollama serve) then refresh.';
        }
      } catch { /* ignore */ }
    } else {
      modelSel.innerHTML = '';
      modelSel.add(new Option(prefs.model || '(type your model id)', prefs.model || ''));
    }
    savePrefs();
  }
  modelSel.addEventListener('change', () => {
    prefs.model = modelSel.value; savePrefs();
    /* remember a model the user chose that isn't a crash risk, so future
       auto-switches can come back to it */
    if ((window.__fitByModel || {})[modelSel.value] !== false) {
      prefs.lastGoodModel = modelSel.value; savePrefs();
    }
    /* instant warning if the user just picked a crash-risk model (unless
       CPU mode makes it safe) — the next refresh auto-switches away */
    const noteEl2 = $('#ollama-note');
    if ((window.__fitByModel || {})[modelSel.value] === false && !prefs.forceCPU) {
      noteEl2.textContent = '⚠ ' + modelSel.value.split('/').pop() + ' is bigger than your VRAM — she would crash or crawl on it. Pick a model without the ⚠ flag, or turn on CPU mode.';
      noteEl2.classList.add('risky');
    } else {
      noteEl2.classList.remove('risky');
    }
    $('#tl-model-name').textContent = prefs.model; $('#foot-model').textContent = prefs.model;
    const cl = (window.__ctxByModel || {})[prefs.model];
    if (cl) { ctxLimit = cl; ctxLimitEl.textContent = fmtTok(cl); setCtx(ctxUsed); }
  });
  $('#btn-refresh-models').addEventListener('click', refreshModels);

  /* voice — settings drawer + quick picker stay in sync */
  const voiceSel = $('#set-voice');
  const quickVoice = $('#quick-voice');
  const fillVoices = () => {
    voiceSel.innerHTML = '';
    quickVoice.innerHTML = '';
    Object.entries(VOICES).forEach(([v, label]) => {
      voiceSel.add(new Option(label, v));
      quickVoice.add(new Option(label, v));
    });
    voiceSel.value = prefs.voice;
    quickVoice.value = prefs.voice;
  };
  fillVoices();
  const onVoiceChange = (el) => () => {
    prefs.voice = el.value;
    savePrefs();
    voiceSel.value = prefs.voice;
    quickVoice.value = prefs.voice;
  };
  voiceSel.addEventListener('change', onVoiceChange(voiceSel));
  quickVoice.addEventListener('change', onVoiceChange(quickVoice));
  const autoSpeakInput = $('#set-auto-speak');
  autoSpeakInput.checked = prefs.autoSpeak;
  autoSpeakInput.addEventListener('change', () => {
    prefs.autoSpeak = autoSpeakInput.checked; savePrefs();
    if (window.joiDesktop) window.joiDesktop.setMuted(!prefs.autoSpeak); // sync tray label
  });

  /* CPU mode toggle (Ollama) — num_gpu:0 on every request, crash-proof */
  const cpuToggle = $('#set-cpu');
  const cpuRow = $('#row-cpu');
  cpuToggle.checked = !!prefs.forceCPU;
  cpuToggle.addEventListener('change', () => {
    prefs.forceCPU = cpuToggle.checked;
    savePrefs();
    refreshModels(); // refresh the note so it reflects CPU mode
  });

  /* desktop EXE extras: system-tray mute events + launch-at-startup toggle */
  if (window.joiDesktop) {
    const desktopPanel = $('#panel-desktop');
    if (desktopPanel) desktopPanel.style.display = '';
    window.joiDesktop.onMute((muted) => {
      prefs.autoSpeak = !muted;
      savePrefs();
      autoSpeakInput.checked = prefs.autoSpeak;
      if (muted) stopSpeaking();
    });
    const autoStart = $('#set-autostart');
    if (autoStart) {
      window.joiDesktop.getAutoLaunch().then((v) => { autoStart.checked = !!v; });
      autoStart.addEventListener('change', () => window.joiDesktop.setAutoLaunch(autoStart.checked));
    }
  }

  /* memory UI (second brain stats) */
  function refreshMemUI() {
    const s = JOIMemory.stats();
    const parts = [];
    if (s.name) parts.push(`She knows you as <b>${s.name}</b>`);
    if (s.factCount) parts.push(`${s.factCount} fact${s.factCount === 1 ? '' : 's'}`);
    if (s.memoryCount) parts.push(`${s.memoryCount} conversation${s.memoryCount === 1 ? '' : 's'} remembered`);
    $('#mem-summary').innerHTML = parts.length
      ? 'Second brain: ' + parts.join(' · ') + '.'
      : 'No name yet. Tell her your name and she will remember. Everything you tell her syncs to the server, so it survives browser resets.';
  }
  $('#btn-forget').addEventListener('click', async () => {
    if (!confirm('Clear the entire second brain — name, facts and all memories?')) return;
    await JOIMemory.clearAll();
    refreshMemUI();
  });

  /* ---------------- server control ---------------- */
  const offline = $('#offline-splash');
  const offlineMsg = $('#offline-msg');
  let serverUp = true;

  async function pingServer() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      return r.ok;
    } catch { return false; }
  }
  function showOffline(msg) {
    serverUp = false;
    offline.style.display = 'flex';
    offlineMsg.textContent = msg || 'Checking for server…';
  }
  async function checkServer({ silent } = {}) {
    const up = await pingServer();
    if (up && !serverUp) { location.reload(); return; }
    if (!up && serverUp) { showOffline('The server went offline.'); return; }
    if (!up && !silent) { showOffline(); return; }
  }
  $('#btn-server-start').addEventListener('click', async () => {
    offlineMsg.textContent = 'Trying to reach the server…';
    // poll until the server answers (started via Start-JOI.bat / npm start)
    for (let i = 0; i < 30; i++) {
      if (await pingServer()) { location.reload(); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    offlineMsg.textContent = 'Still no server. Launch Start-JOI.bat (or npm start) and click again.';
  });
  setInterval(() => { if (!serverUp) checkServer({ silent: true }); }, 4000);

  $('#btn-server-stop').addEventListener('click', async () => {
    if (!confirm('Stop the JOI server? The page will show the Start screen until you bring her back.')) return;
    const btn = $('#btn-server-stop');
    btn.textContent = '⏻ Stopping…';
    try {
      await fetch('/api/server/stop', { method: 'POST' });
      showOffline('Server stopped. Bring her back with Start-JOI.bat.');
    } catch { showOffline('Server stopped.'); }
  });
  $('#btn-server-restart').addEventListener('click', async () => {
    const btn = $('#btn-server-restart');
    btn.textContent = '⟳ Restarting…';
    try {
      await fetch('/api/server/restart', { method: 'POST' });
      // the current connection dies — poll for the fresh server
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await pingServer()) { location.reload(); return; }
      }
      showOffline('Restart did not complete. Launch Start-JOI.bat.');
    } catch { showOffline('Restart did not complete. Launch Start-JOI.bat.'); }
  });

  /* ---------------- boot ---------------- */
  (async function boot() {
    const up = await pingServer();
    if (!up) { showOffline(); return; }
    serverUp = true;
    initEngine();
    ctxLimitEl.textContent = fmtTok(ctxLimit);
    /* second brain: pull server memory (survives browser resets) */
    await JOIMemory.pullServer();
    refreshMemUI();
    syncProviderUI();
    baseInput.value = prefs.base || '';
    keyInput.value = prefs.key;
    await refreshModels();
    /* warm greeting with a Blade Runner quote */
    const name = JOIMemory.getName();
    setTimeout(() => {
      const q = JOIQuotes.forCategory('greeting');
      addMsg('joi quote', `<span class="em">Joi · Blade Runner</span>${mdInline(mdEscape(q))}`, 'she remembers you');
      if (name) {
        setTimeout(() => addMsg('joi', mdInline(mdEscape(`I remember you, ${name}. I always told you — you were special.`) + ` <span style="opacity:.55;font-size:11px">(say hello, ask me anything, or throw a problem at me — code, life, whatever.)</span>`), 'companion'), 1400);
      }
      setTimeout(() => speak(q), 2400);
    }, 700);
  })();
})();
