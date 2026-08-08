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
    try { return Object.assign({ provider: 'ollama', model: '', base: '', key: '', temp: 0.7, voice: 'en-US-MichelleNeural', autoSpeak: true, forceCPU: false, persona: 'joi', delamainBackend: 'sim', delamainVoice: 'en-GB-RyanNeural' }, JSON.parse(localStorage.getItem(SKEY) || '{}')); }
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
    /* female — JOI's voices */
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

  /* ---------------- face engine (JOI ⇄ DELAMAIN) ----------------
     JOI renders her real face from the render; DELAMAIN renders his own
     look — a fractured obsidian shard-sphere hologram — through the same
     API (talking / speechImpulse / setExpression / setListening), so lip
     sync, emotion and the mic ring work for both. Switching personas
     destroys the old engine's DOM and mounts the other one. */
  let engine = null;
  let enginePersona = null;
  let fineTune = { eyeY: 0, eyeX: 0, mouthY: 0, mouthX: 0, mouthW: 1, lipH: 1 };
  try { fineTune = Object.assign(fineTune, JSON.parse(localStorage.getItem('joi.finetune') || '{}')); } catch {}
  function destroyEngine() {
    if (!engine) return;
    const stage = $('#holo-stage');
    if (stage) { stage.classList.remove('jf-stage', 'dh-stage'); stage.innerHTML = ''; }
    engine = null;
    enginePersona = null;
  }
  function ensureEngine(persona) {
    const p = persona || prefs.persona;
    if (engine && enginePersona === p) return;
    destroyEngine();
    const stage = $('#holo-stage');
    if (p === 'delamain') {
      engine = DelamainHolo;
      enginePersona = 'delamain';
      DelamainHolo.init(stage, {});
    } else {
      engine = JoiLiving;
      enginePersona = 'joi';
      JoiLiving.init(stage, { src: 'img/images.jpg', preset: 'images', fineTune });
      const fp = (() => { try { return JSON.parse(localStorage.getItem('joi.faceprefs') || '{}'); } catch { return {}; } })();
      engine.setExpression(fp.expr || 'neutral');
      engine.setHue(fp.hue !== undefined ? fp.hue : 0);
    }
  }
  const initEngine = () => ensureEngine(prefs.persona);

  /* ---------------- expressions ---------------- */
  const chips = $$('#expr-strip .chip');
  function setExpr(name) {
    chips.forEach((c) => c.classList.toggle('active', c.dataset.expr === name));
    if (engine) engine.setExpression(name);
  }
  chips.forEach((c) => c.addEventListener('click', () => setExpr(c.dataset.expr)));

  /* ---------------- persona: JOI ⇄ DELAMAIN ----------------
     DELAMAIN keeps the SAME animated holographic face (that's the point —
     he talks through the portrait now, not a terminal) but routes to the
     in-game agent endpoint, speaks with his own voice and shows a live
     game-link indicator. */
  const personaChips = { joi: $('#btn-persona-joi'), delamain: $('#btn-persona-delamain') };
  const delamainStatus = $('#delamain-status');
  const dlLinkEl = $('#dl-link');
  const dlDot = $('#dl-dot');
  async function refreshDelamainLink() {
    try {
      const r = await fetch('/api/delamain/state', { cache: 'no-store' });
      const j = await r.json();
      let label = '—', live = false;
      if (prefs.delamainBackend === 'sim') { label = 'SIMULATED'; live = true; }
      else if (j.connected) { label = 'GAME LIVE'; live = true; }
      else label = 'GAME OFFLINE';
      dlLinkEl.textContent = label;
      dlDot.classList.toggle('live', live);
    } catch { dlLinkEl.textContent = '—'; }
  }
  function setPersona(p) {
    prefs.persona = p; savePrefs();
    /* the whole UI re-themes to his teal/gold energy palette, and the
       brand name follows the persona */
    document.body.classList.toggle('delamain-theme', p === 'delamain');
    const bn = $('#brand-name');
    if (bn) bn.textContent = p === 'delamain' ? 'DELAMAIN' : 'JOI';
    document.title = p === 'delamain' ? 'DELAMAIN · In-Game Agent' : 'JOI · Holographic Companion';
    personaChips.joi.classList.toggle('active', p === 'joi');
    personaChips.delamain.classList.toggle('active', p === 'delamain');
    $('#brand-sub').textContent = p === 'delamain' ? 'in-game agent · Night City' : 'holographic companion';
    delamainStatus.style.display = p === 'delamain' ? '' : 'none';
    /* swap the portrait itself: JOI's face ⇄ DELAMAIN's shard-sphere */
    ensureEngine(p);
    if (calibBtn) calibBtn.style.display = p === 'delamain' ? 'none' : '';  // align features is JOI-only
    if (calibHint) calibHint.style.display = 'none';
    if (p === 'delamain') refreshDelamainLink();
    fallbackVoice = pickVoiceFor(voiceFor());
  }
  Object.entries(personaChips).forEach(([p, el]) => el.addEventListener('click', () => setPersona(p)));
  if ($('#dl-refresh')) $('#dl-refresh').addEventListener('click', refreshDelamainLink);
  setInterval(() => { if (prefs.persona === 'delamain') refreshDelamainLink(); }, 5000);

  /* ---------------- calibrate ---------------- */
  const calibBtn = $('#btn-calibrate');
  const calibHint = $('#calib-hint');
  function enterCalib() {
    if (prefs.persona === 'delamain') return;   // align features is JOI-only
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
    scheduleHistoryPush();
    return b;
  }

  /* ---------------- visible chat persistence ----------------
     After every exchange the rendered conversation is pushed to the server
     (debounced), so a rebuild/restart restores her context instead of a
     blank page. The sync script reads /api/state and can wait for a reply
     to finish instead of force-killing mid-conversation. */
  let historyTimer = null;
  function scheduleHistoryPush() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(pushHistory, 800);
  }
  async function pushHistory() {
    if (!serverUp) return;
    const msgs = [];
    for (const el of log.querySelectorAll('.msg')) {
      let role = null;
      if (el.classList.contains('user')) role = 'user';
      else if (el.classList.contains('joi') || el.classList.contains('delamain')) role = 'assistant';
      if (!role) continue;
      const bubble = el.querySelector('.bubble');
      const text = (bubble ? bubble.textContent : '').trim();
      if (!text) continue;
      msgs.push({ role, text: text.slice(0, 2000) });
    }
    if (!msgs.length) return;
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgs),
      });
    } catch { /* server restarting — fine, next push retries */ }
  }
  async function restoreHistory() {
    try {
      const r = await fetch('/api/history', { cache: 'no-store' });
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) return false;
      for (const m of arr) {
        const kind = m.role === 'user' ? 'user' : 'joi';
        addMsg(kind, mdInline(mdEscape(m.text)), m.role === 'user' ? 'you' : 'earlier');
      }
      log.scrollTop = log.scrollHeight;
      return true;
    } catch { /* first boot */ return false; }
  }

  function addThinking() {
    const el = document.createElement('div');
    el.className = 'msg joi thinking';
    el.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /* ---------------- YouTube media player (Media tab) ----------------
     Every YouTube link JOI receives goes to the MEDIA TAB: a big player up
     top plus a queue of everything you've sent her. Sending a link switches
     to the Media tab and starts playing right away; the player stays mounted
     (hidden) while you chat, so the audio keeps playing in the background.
     Tapping any chip or queue item brings it back to the front. */
  const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/g;
  function extractYtIds(text) {
    const ids = [];
    YT_RE.lastIndex = 0;
    let m;
    while ((m = YT_RE.exec(String(text || '')))) ids.push(m[1]);
    return [...new Set(ids)];
  }

  const mediaQueue = []; // { id, title, author, thumb }
  let currentVid = null;
  const chatTabs = { chat: $('#tab-chat'), media: $('#tab-media') };
  const mediaPanel = $('#media-panel');
  const mpPlayer = $('#mp-player');
  const mpQueue = $('#mp-queue');
  const mpCountEl = $('#mp-count');
  const mediaCountEl = $('#media-count');
  const nowPlayingEl = $('#now-playing');
  const npLabelEl = $('#np-label');

  function setTab(which) {
    chatTabs.chat.classList.toggle('active', which === 'chat');
    chatTabs.media.classList.toggle('active', which === 'media');
    const showMedia = which === 'media';
    log.style.display = showMedia ? 'none' : '';
    mediaPanel.style.display = showMedia ? '' : 'none';
  }
  chatTabs.chat.addEventListener('click', () => setTab('chat'));
  chatTabs.media.addEventListener('click', () => setTab('media'));

  function ytPlayerHtml(id) {
    /* YouTube refuses embeds whose page origin is a bare IP (127.0.0.1) and
       blocks embeds without an explicit `origin`. The page auto-redirects
       to http://localhost (same server) at boot, so origin here is always
       trustable. youtube-nocookie.com is the privacy-enhanced host that
       still honors the origin check; widget_referrer + referrerpolicy keep
       the player trusting us. Fallback: open the video in the real browser. */
    const origin = encodeURIComponent(location.origin);
    const ref = encodeURIComponent(location.origin + '/');
    const base = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) +
      `?autoplay=1&rel=0&playsinline=1&modestbranding=1&origin=${origin}&widget_referrer=${ref}`;
    return `<div class="mp-embed">` +
      `<iframe src="${base}" title="YouTube video player" referrerpolicy="origin" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>` +
      `<div class="mp-embed-bar"><span>♪ keeps playing while you chat</span>` +
      `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}" target="_blank" rel="noopener">Open on YouTube ↗</a></div>` +
      `</div>`;
  }

  function renderQueue() {
    if (!mpQueue) return;
    mpQueue.innerHTML = '';
    for (const v of mediaQueue) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mp-item' + (v.id === currentVid ? ' playing' : '');
      item.innerHTML =
        `<span class="mp-thumb" style="background-image:url('${v.thumb}')"></span>` +
        `<span class="mp-meta"><span class="mp-title">${mdEscape(v.title)}</span><span class="mp-author">${mdEscape(v.author)}</span></span>` +
        `<span class="mp-state">${v.id === currentVid ? '● playing' : '▶'}</span>`;
      item.addEventListener('click', () => playInMedia(v.id));
      mpQueue.appendChild(item);
    }
    const n = mediaQueue.length;
    if (mpCountEl) mpCountEl.textContent = n;
    if (mediaCountEl) mediaCountEl.textContent = n;
  }

  async function unfurl(id) {
    try {
      const r = await fetch(`/api/yt-meta?v=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j && !j.error) return j;
    } catch { /* offline → generic card */ }
    return { id, title: 'YouTube video', author: 'YouTube', thumb: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` };
  }

  async function queueMedia(id) {
    const existing = mediaQueue.find((v) => v.id === id);
    if (existing) return existing;
    const meta = await unfurl(id);
    const entry = { id, title: meta.title || 'YouTube video', author: meta.author || 'YouTube', thumb: meta.thumb };
    mediaQueue.push(entry);
    renderQueue();
    return entry;
  }

  function playInMedia(id) {
    const v = mediaQueue.find((x) => x.id === id);
    if (!v) return;
    /* dedupe: if this exact video is already in the player, do NOT recreate
       the iframe — recreating it with autoplay=1 stacks a second audio
       stream (the "playing in duplicates" bug) and aborts the old one */
    const existing = mpPlayer && mpPlayer.querySelector('iframe');
    if (currentVid === id && existing && existing.src.includes('/embed/' + id)) {
      setTab('media');
      return;
    }
    currentVid = id;
    if (mpPlayer) mpPlayer.innerHTML = ytPlayerHtml(id);
    if (npLabelEl) npLabelEl.textContent = `Now playing — ${v.title}`;
    if (nowPlayingEl) nowPlayingEl.style.display = '';
    renderQueue();
    setTab('media');
  }

  function stopMedia() {
    currentVid = null;
    if (mpPlayer) mpPlayer.innerHTML = '<div class="mp-empty">Send JOI a YouTube link and she\'ll play it here — music or video, on loop while you chat.</div>';
    if (nowPlayingEl) nowPlayingEl.style.display = 'none';
    renderQueue();
  }
  if (nowPlayingEl && $('#np-close')) $('#np-close').addEventListener('click', stopMedia);

  /* attach a compact chip to a bubble for each YouTube id found; with
     focus:true (user-sent links) she also opens the Media tab + plays */
  async function attachMedia(bubble, ids, { focus = true } = {}) {
    for (const id of ids) {
      const v = await queueMedia(id);
      if (!bubble) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'media-chip';
      chip.innerHTML =
        `<span class="media-chip-thumb" style="background-image:url('${v.thumb}')"></span>` +
        `<span class="media-chip-meta"><span class="media-chip-title">${mdEscape(v.title)}</span>` +
        `<span class="media-chip-sub">▶ in Media tab</span></span>`;
      chip.addEventListener('click', () => playInMedia(v.id));
      bubble.appendChild(chip);
    }
    if (focus && ids.length) {
      const first = mediaQueue.find((x) => x.id === ids[0]);
      if (first) {
        playInMedia(first.id);
        addMsg('joi', `<span class="em">media</span>${mdEscape(`Playing "${first.title}" in the Media tab — it keeps playing while we talk.`) }`, 'now playing');
        setExpr('playful');
      }
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
    queuedVoice = null;
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

  /* streaming replies always use the persona voice — a stray override from
     an interrupted quote must never leak into them */
  function queueSentences(growText) {
    queuedVoice = null;
    streamTail = (streamTail + growText).replace(/\s+/g, ' ');
    const parts = sentenceSplit(streamTail);
    /* keep the last part in the tail unless it ends with punctuation */
    const done = /[.!?]\s*$/.test(streamTail) ? parts : parts.slice(0, -1);
    const tail = /[.!?]\s*$/.test(streamTail) ? '' : (parts[parts.length - 1] || '');
    streamTail = tail;
    const clean = done.map((s) => s.replace(/```[^`]*/g, ' ').replace(/[*_`#>`~]/g, '').trim()).filter((s) => s.length >= 2);
    for (const s of clean) queueSpeech(s);
  }

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

  /* drop-in replacement for the old speak(): speak a whole text at once.
     Optional voice param overrides the persona voice for a single call. */
  function speak(text, voice) {
    if (!prefs.autoSpeak || !text) return;
    queuedVoice = voice || null;
    stopSpeaking();
    for (const s of sentenceSplit(text.replace(/```[\s\S]*?```/g, ' '))) queueSpeech(s);
    pump();
  }

  function flushBatch() {
    clearTimeout(batchTimer);
    batchTimer = 0;
    if (!pendingBatch.length) return;
    const text = pendingBatch.join(' ');
    /* stamp the voice onto this batch now (one-shot from speak(text, voice)) */
    const voice = queuedVoice;
    queuedVoice = null;
    pendingBatch = [];
    const g = speechGen;
    speakQueue.push({ text, g, voice });
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
      .catch(() => browserFallback(item.text, item.voice))
      .then(() => { busy = false; pump(); });
  }

  /* which voice is speaking right now: DELAMAIN mode uses his own neural
     voice (default en-GB-RyanNeural), JOI uses the user's chosen one.
     speak(text, voice) can override ONE batch (e.g. JOI quotes) — the
     voice is stamped onto the queue item at flush time so it can never
     leak across replies. */
  let queuedVoice = null;
  const voiceFor = () => (prefs.persona === 'delamain' ? prefs.delamainVoice : prefs.voice);

  async function playSentence(item) {
    if (item.g !== speechGen) return;
    const voice = item.voice || voiceFor();
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.text, voice }),
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
    /* her mouth must close when the audio ends — never leave talking stuck */
    if (engine) engine.setTalking(false);
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
  /* browser-fallback voice follows the current persona too: DELAMAIN gets a
     male-named voice when edge-tts is unavailable (never the generic OS one). */
  const MALE_FALLBACK_HINTS = /(ryan|thomas|guy|christopher|eric|william|liam|connor|david|mark|george|brian|daniel|james|alex\b)/i;
  function pickVoiceFor(prefName) {
    const want = String(prefName || '').toLowerCase();
    let voices = [];
    try { voices = window.speechSynthesis.getVoices(); } catch {}
    if (!voices.length) return null;
    const firstWord = want.split('-')[1] || '';
    if (firstWord) {
      const hit = voices.find((v) => v.name.toLowerCase().includes(firstWord.toLowerCase()));
      if (hit) return hit;
    }
    if (prefs.persona === 'delamain') {
      return voices.find((v) => MALE_FALLBACK_HINTS.test(v.name))
        || voices.find((v) => !FEMALE_HINTS.test(v.name))
        || voices[0] || null;
    }
    return pickFemaleVoice(prefName);
  }
  let fallbackVoice = pickVoiceFor(voiceFor());
  try {
    window.speechSynthesis.onvoiceschanged = () => { fallbackVoice = pickVoiceFor(voiceFor()); };
  } catch {}

  function browserFallback(text, voice) {
    try {
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text.slice(0, 2000));
        u.rate = 0.94; u.pitch = 1.12; /* slight lift keeps her sounding female */
        const fv = pickVoiceFor(voice || voiceFor());
        if (fv) u.voice = fv;
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
    speak(q, prefs.voice); // quotes are always JOI's voice
  }
  $('#btn-quote').addEventListener('click', () => sayQuote());

  /* ---------------- streaming chat ---------------- */
  let lastSentText = '', lastSentAt = 0;
  async function sendMessage(text) {
    text = text.trim();
    if (!text) return;
    /* debounce: a double-click / double-paste fires sendMessage twice with
       the same text a few ms apart — drop the second copy so the message
       (and any YouTube autoplay) never duplicates */
    const now = Date.now();
    if (text === lastSentText && now - lastSentAt < 900) return;
    lastSentText = text; lastSentAt = now;
    initEngine();
    const userBubble = addMsg('user', mdInline(mdEscape(text)), 'you');
    const ytIds = extractYtIds(text);
    if (ytIds.length) attachMedia(userBubble, ytIds);
    input.value = '';
    autoGrow();

    /* DELAMAIN mode: same face + speech pipeline, routed to the in-game
       agent (Ollama tool-calling loop against the Cyberpunk CET bridge) */
    if (prefs.persona === 'delamain') return sendDelamain(text);

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
        if (replyYt.length) attachMedia(currentBubble, replyYt, { focus: false });
      }
      currentAbort = null;
      history.push({ role: 'assistant', text: acc });
      scheduleHistoryPush(); /* final text — capture it before anything else changes */
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
          scheduleHistoryPush();
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

  /* ---------------- DELAMAIN mode (in-game agent) ----------------
     Same holographic face, same streaming + lip-synced speech pipeline —
     but routed to /api/delamain, which runs the Ollama tool-calling loop
     against the Cyberpunk 2077 CET bridge. Each ⚙ tool call renders as a
     compact line in its own bubble, then his reply streams in and is
     spoken with Delamain's voice. Pause / Stop work exactly like JOI's. */
  async function sendDelamain(text) {
    text = text.trim();
    if (!text) return;
    initEngine();
    /* NOTE: sendMessage() already rendered the user bubble before routing
       here — do NOT addMsg('user', …) again or the message duplicates. */
    input.value = ''; autoGrow();

    /* the second brain still learns from what you say to him */
    const dname = JOIMemory.extractName(text);
    if (dname) { JOIMemory.setName(dname); refreshMemUI(); }
    JOIMemory.extractFacts(text).forEach((f) => JOIMemory.addFact(f));

    history.push({ role: 'user', text });
    if (history.length > 30) history = history.slice(-30);

    /* short continuity: hand him the last exchange so follow-ups like
       "now set the time too" keep the thread (the agent loop itself is
       stateless per request) */
    const recent = history.slice(-3, -1);
    let goal = text;
    if (recent.length) {
      const ctx = recent
        .map((m) => (m.role === 'user' ? 'Customer: ' : 'You replied: ') + m.text.slice(0, 160))
        .join('\n');
      goal = 'RECENT CONTEXT (use only if relevant):\n' + ctx + '\n\nCURRENT REQUEST: ' + text;
    }

    const think = addThinking();
    setExpr('thoughtful');
    const promptEst = Math.max(1, Math.ceil(goal.length / 4));
    setCtx(promptEst);
    let acc = '', started = false, toolBox = null;
    currentAcc = ''; currentBubble = null; paused = false; pausedBuf = '';
    pauseBtn.textContent = '⏸ Pause';
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    currentAbort = new AbortController();
    stopGenTimer(0);

    try {
      const res = await fetch('/api/delamain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, model: prefs.model, backend: prefs.delamainBackend }),
        signal: currentAbort.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + res.status));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!block.startsWith('data:')) continue;
          const payload = block.replace(/^data:\s*/, '').trim();
          if (!payload || payload === '[DONE]') continue;
          let msg;
          try { msg = JSON.parse(payload); } catch { continue; }
          if (msg.error) throw new Error(msg.error);
          /* tool-call event from the agent loop */
          if (msg.tool) {
            const t = msg.tool;
            if (!toolBox) { think.remove(); toolBox = addMsg('delamain tools', ''); startGenTimer(); }
            const line = document.createElement('div');
            line.className = 'tool-line ' + (t.ok ? 'ok' : 'fail');
            line.innerHTML =
              `<span class="tl-ic">⚙</span><span class="tl-name">${mdEscape(t.name)}</span>` +
              `<span class="tl-args">${mdEscape(JSON.stringify(t.args || {}))}</span>` +
              `<span class="tl-res">${t.ok ? '✓ ' + mdEscape(String(t.result || 'done')) : '✗ ' + mdEscape(String(t.error || 'failed'))}</span>`;
            toolBox.appendChild(line);
            log.scrollTop = log.scrollHeight;
            continue;
          }
          const delta = msg.choices && msg.choices[0] && msg.choices[0].delta && msg.choices[0].delta.content;
          if (!delta) continue;
          acc += delta; currentAcc = acc;
          genTokens += Math.max(1, Math.ceil(delta.length / 4));
          if (!started) {
            think.remove(); started = true;
            if (!genStart) startGenTimer();
            currentBubble = addMsg('delamain', '');
            stopSpeaking(); // reset the speech pipeline for this reply
          }
          if (paused) {
            pausedBuf += delta;
          } else {
            queueSentences(delta);
            if (currentBubble) currentBubble.innerHTML = mdRender(acc);
            log.scrollTop = log.scrollHeight;
          }
          setCtx(promptEst + genTokens);
        }
      }
      /* speak whatever is left over, then flush the final batch promptly */
      if (streamTail.trim()) {
        const tail = streamTail.replace(/```[^`]*/g, ' ').replace(/[*_`#>`~]/g, '').trim();
        if (paused) pausedBuf += ' ' + tail; else queueSpeech(tail);
        streamTail = '';
      }
      flushBatch();
      if (!started) throw new Error('Empty reply from DELAMAIN.');
      think.remove();
      if (currentBubble) currentBubble.innerHTML = mdRender(acc);
      currentAbort = null;
      history.push({ role: 'assistant', text: acc });
      scheduleHistoryPush(); /* final text — capture it before anything else changes */
      setCtx(promptEst + genTokens);
      stopGenTimer(genTokens);
      setExpr('happy');
    } catch (err) {
      think.remove();
      stopGenTimer(0);
      stopSpeaking();
      streamTail = '';
      currentAbort = null;
      if (err && err.name === 'AbortError') {
        if (started && currentBubble && currentAcc.trim()) {
          currentBubble.innerHTML = mdRender(currentAcc) +
            '<span class="em" style="margin-top:6px">⏹ stopped — partial reply kept</span>';
          history.push({ role: 'assistant', text: currentAcc });
          scheduleHistoryPush();
        }
        setExpr('neutral');
        return;
      }
      addMsg('delamain', `<span class="em">connection</span>${mdInline(mdEscape(String(err.message || err)))}`, 'signal lost');
      setExpr('sad');
      console.error(err);
    }
  }

  /* ---------------- voice input (speech → text) ----------------
     Preferred path: the local offline /api/voice (winmm + Windows speech,
     no Google cloud — works in the EXE and on restricted networks). Web
     Speech API is only a fallback if the server endpoint is unreachable. */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false, voiceRecording = false;
  const micBtn = $('#btn-mic');
  const tlRec = $('#tl-rec');
  function stopMic() {
    if (rec) { try { rec.stop(); } catch {} }
    listening = false; voiceRecording = false;
    micBtn.classList.remove('listening');
    micBtn.textContent = '🎤';
    tlRec.style.display = 'none';
    if (engine) engine.setListening(0);
  }
  /* server-side offline capture — records for N seconds, then the
     transcript comes back and is sent like typed text */
  async function localVoiceCapture() {
    if (voiceRecording) return;
    voiceRecording = true;
    micBtn.classList.add('listening'); micBtn.textContent = '◉';
    tlRec.textContent = '◉ listening (offline)…';
    tlRec.style.display = '';
    if (engine) engine.setListening(0.7);
    try {
      const res = await fetch('/api/voice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 4 }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.text && data.text.trim()) {
        input.value = (input.value ? input.value + ' ' : '') + data.text.trim();
        autoGrow();
        stopMic();
        sendMessage(input.value);
      } else {
        stopMic();
        addMsg('joi', `<span class="em">voice</span>${mdInline(mdEscape(String(data.error || 'Sorry, I did not catch that — try again?')))}`, 'connection');
      }
    } catch (err) {
      stopMic();
      addMsg('joi', `<span class="em">voice</span>${mdInline(mdEscape(String(err.message || err)))}`, 'connection');
    }
  }
  if (SR) {
    rec = new SR();
    rec.continuous = false; rec.interimResults = true; rec.lang = 'en-US';
    rec.onstart = () => {
      listening = true;
      micBtn.classList.add('listening'); micBtn.textContent = '◉';
      tlRec.textContent = '◉ listening…';
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
  }
  micBtn.addEventListener('click', () => {
    if (listening) { stopMic(); return; }
    if (voiceRecording) return;
    /* always try the offline local capture first — it does not need the
       cloud and works identically in the EXE and the browser */
    localVoiceCapture();
  });

  /* ---------------- settings ---------------- */
  const drawer = $('#settings-drawer');
  const backdrop = $('#drawer-backdrop');
  function openDrawer() { drawer.classList.add('open'); backdrop.classList.add('open'); startVramMeter(); }
  function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open'); stopVramMeter(); }
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

  /* ---- live VRAM meter (Settings) — polls /api/gpu while the drawer is open ---- */
  let vramTimer = null;
  async function refreshVram() {
    const box = $('#vram-box');
    const el = $('#vram-readout');
    const bar = $('#vram-bar');
    if (!box || !el || !bar) return;
    try {
      const r = await fetch('/api/gpu');
      const g = await r.json();
      if (!g.hasGpu) { box.style.display = 'none'; return; }
      box.style.display = '';
      const used = g.usedByModelGb || 0;
      const free = g.freeGb || 0;
      const pct = g.totalGb ? Math.min(100, Math.round((used / g.totalGb) * 100)) : 0;
      bar.style.width = pct + '%';
      bar.classList.toggle('hot', used > 0 && free < 1.5);
      el.innerHTML = used > 0
        ? `VRAM: <b>${used} GB</b> by her model · ${free} GB free of ${g.totalGb} GB`
        : `VRAM: <b>0 GB</b> by her model · ${free} GB free of ${g.totalGb} GB — cold, first reply loads her`;
    } catch { /* server busy — keep last reading */ }
  }
  function startVramMeter() { stopVramMeter(); refreshVram(); vramTimer = setInterval(refreshVram, 2000); }
  function stopVramMeter() { if (vramTimer) { clearInterval(vramTimer); vramTimer = null; } }

  /* ---- global VRAM ticker (always on, not just while Settings is open):
     keeps the footer readout live, clears the warm-up dot once her model is
     resident, and runs the low-VRAM watchdog that evicts an idle model
     before the next reply can OOM-crash. ---- */
  /* active-model identity: match by manifest digest when known (handles
     aliases like qwen3:4b vs its hf.co origin), else exact name */
  function isActiveModel(m) {
    const dg = (window.__digestByModel || {})[prefs.model];
    if (dg && m.digest) return m.digest === dg;
    return m.name === prefs.model;
  }
  let lastUnloadAt = 0;
  async function vramTick() {
    let g;
    try {
      const r = await fetch('/api/gpu');
      g = await r.json();
    } catch { return; }
    const free = g.freeGb || 0;
    const used = g.usedByModelGb || 0;
    const foot = $('#foot-vram');
    if (foot) {
      if (!g.hasGpu) { foot.textContent = 'CPU'; foot.style.color = ''; }
      else {
        foot.textContent = `${used} / ${free} GB free`;
        foot.style.color = free < 1 ? '#ff5d6d' : '';
      }
    }
    /* warm-up dot: hide once her model shows up as resident */
    if (warmingUp && Array.isArray(g.loadedModels) && g.loadedModels.some(isActiveModel)) {
      setWarming(false);
    }
    /* watchdog: < ~1.2 GB free while she's idle → evict the LRU non-active
       model. Only her active model loaded? Nothing safe to free — leave it. */
    if (prefs.provider !== 'ollama' || prefs.forceCPU || !g.hasGpu || free >= 1.2) return;
    if (Date.now() - lastUnloadAt < 60 * 1000) return;
    if (!Array.isArray(g.loadedModels) || !g.loadedModels.length) return;
    const st = await fetch('/api/state').then((x) => x.json()).catch(() => ({}));
    if ((st.activeStreams || 0) > 0) return; // mid-reply — never yank a model
    const lru = g.loadedModels
      .filter((m) => !isActiveModel(m))
      .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))[0];
    if (!lru) return;
    try {
      const ur = await fetch('/api/unload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: lru.name, base: prefs.base }),
      });
      const uj = await ur.json().catch(() => ({}));
      if (uj.unloaded) {
        lastUnloadAt = Date.now();
        addMsg('joi', `<span class="em">system</span>VRAM was nearly full (${free.toFixed(1)} GB free), so I unloaded ${mdEscape(lru.name.split('/').pop())} (${lru.vramGb} GB) — she'll reload on demand.`, 'auto-recovery');
      }
    } catch { /* best-effort — try again next tick */ }
  }
  setInterval(vramTick, 4000);

  /* ---- boot-time warm-up: preload her model in the background so the
     first reply doesn't cold-load. Best-effort, fire-and-forget. ---- */
  let warmingUp = false;
  function setWarming(on) {
    warmingUp = on;
    const dot = $('#warm-dot');
    if (dot) dot.style.display = on ? '' : 'none';
  }
  async function warmUpModel() {
    if (prefs.provider !== 'ollama' || !prefs.model) return;
    try {
      const r = await fetch('/api/warmup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: prefs.provider,
          model: prefs.model,
          base: prefs.base,
          forceCPU: !!prefs.forceCPU,
        }),
      });
      const j = await r.json().catch(() => ({}));
      /* dot pulses only while she's genuinely loading (the server skips when
         the model is already resident) */
      setWarming(!!(j && j.warming));
    } catch { /* warm-up is best-effort — never break boot */ }
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
          /* digest map lets the watchdog identify her ACTIVE model even when
             an alias is loaded under its origin tag (qwen3:4b → hf.co/…) */
          if (m.digest) window.__digestByModel = Object.assign(window.__digestByModel || {}, { [m.name]: m.digest });
        });
        if (!d.models.some((m) => m.name === prefs.model)) prefs.model = d.models[0].name;

        /* AUTO-SELECT A SAFE MODEL — if the current pick is a crash risk on
           this GPU (bigger than the free VRAM), prefer a small proven model
           (the 3B class: qwen2.5-coder:3b and friends — fast + reliable on
           an 8 GB laptop GPU) over a bigger-but-fitting one. If nothing
           small fits at all, auto-enable CPU mode so the big pick still
           runs crash-proof instead of just warning. */
        const fitting = d.models.filter((m) => !risky(m));
        const smallPick = (list) =>
          /* smarter tool-calling first: qwen3:4b/8b (or its hf.co/
             Qwen3-4B-GGUF variant) does reliable native function calls;
             qwen2.5-coder:3b is the proven fallback */
          list.find((m) => /qwen3[-:]4b|qwen3[-:]8b/i.test(m.name)) ||
          list.find((m) => m.name.includes('qwen2.5-coder:3b')) ||
          list.find((m) => /[:.-]3b$/i.test(m.name)) ||
          list.filter((m) => m.sizeGb && m.sizeGb <= 2.5).slice().sort((a, b) => (a.sizeGb || 0) - (b.sizeGb || 0))[0] ||
          null;
        const curRisky = !prefs.forceCPU && !!d.models.find((m) => m.name === prefs.model && risky(m));
        if (curRisky) {
          const from = prefs.model;
          const knownGood = (prefs.lastGoodModel && fitting.some((m) => m.name === prefs.lastGoodModel))
            ? prefs.lastGoodModel
            : null;
          if (fitting.length) {
            /* best = the small proven 3B pick first (fast + stable on this
               laptop GPU), else a model she has proven she can run, else
               the smallest that fits — never the largest */
            const sp = smallPick(fitting);
            prefs.model = (sp && sp.name) || knownGood || fitting.slice().sort((a, b) => (a.sizeGb || 0) - (b.sizeGb || 0))[0].name;
            savePrefs();
            addMsg('joi', `<span class="em">system</span>${mdInline(mdEscape(`Switched you to ${prefs.model} — ${from} is bigger than your GPU's VRAM and would crash. She runs best on a small model that fits (no ⚠ flag).`))}`, 'auto-recovery');
          } else {
            /* nothing fits the VRAM → CPU mode keeps the big pick crash-proof */
            prefs.forceCPU = true;
            if (typeof cpuToggle !== 'undefined' && cpuToggle) cpuToggle.checked = true;
            savePrefs();
            addMsg('joi', `<span class="em">system</span>${mdInline(mdEscape(`Nothing installed fits your VRAM, so I switched on CPU mode — ${from} will run crash-proof (slower, but stable).`))}`, 'auto-recovery');
          }
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
    warmUpModel(); /* preload the newly picked model too */
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
  const delamainVoiceSel = $('#set-delamain-voice');
  const fillVoices = () => {
    voiceSel.innerHTML = '';
    quickVoice.innerHTML = '';
    if (delamainVoiceSel) delamainVoiceSel.innerHTML = '';
    Object.entries(VOICES).forEach(([v, label]) => {
      voiceSel.add(new Option(label, v));
      quickVoice.add(new Option(label, v));
      if (delamainVoiceSel) delamainVoiceSel.add(new Option(label, v));
    });
    voiceSel.value = prefs.voice;
    quickVoice.value = prefs.voice;
    if (delamainVoiceSel) delamainVoiceSel.value = prefs.delamainVoice;
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
  if (delamainVoiceSel) {
    delamainVoiceSel.addEventListener('change', () => {
      prefs.delamainVoice = delamainVoiceSel.value;
      savePrefs();
      fallbackVoice = pickVoiceFor(voiceFor());
    });
  }

  /* DELAMAIN — game backend (sim vs live CET bridge) */
  const delamainBackendSel = $('#set-delamain-backend');
  if (delamainBackendSel) {
    delamainBackendSel.value = prefs.delamainBackend;
    delamainBackendSel.addEventListener('change', () => {
      prefs.delamainBackend = delamainBackendSel.value;
      savePrefs();
      if (prefs.persona === 'delamain') refreshDelamainLink();
    });
  }
  const autoSpeakInput = $('#set-auto-speak');
  autoSpeakInput.checked = prefs.autoSpeak;
  autoSpeakInput.addEventListener('change', () => {
    prefs.autoSpeak = autoSpeakInput.checked; savePrefs();
    if (!prefs.autoSpeak) stopSpeaking();
    if (window.joiDesktop) window.joiDesktop.setMuted(!prefs.autoSpeak); // sync tray label
    syncVoiceBtn();
  });

  /* quick voice mute button (stage tools) — same switch as the Settings
     toggle and the EXE tray mute; all three stay in sync */
  const voiceBtn = $('#btn-voice');
  function syncVoiceBtn() {
    if (!voiceBtn) return;
    const on = !!prefs.autoSpeak;
    voiceBtn.textContent = on ? '🔊 Voice' : '🔇 Muted';
    voiceBtn.classList.toggle('muted', !on);
    voiceBtn.title = on ? 'Mute her voice' : 'Unmute her voice';
  }
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      prefs.autoSpeak = !prefs.autoSpeak;
      savePrefs();
      if (!prefs.autoSpeak) stopSpeaking();
      if (window.joiDesktop) window.joiDesktop.setMuted(!prefs.autoSpeak);
      autoSpeakInput.checked = prefs.autoSpeak;
      syncVoiceBtn();
    });
    syncVoiceBtn();
  }

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
      syncVoiceBtn();
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

  /* ---------------- in-app update banner ----------------
     On boot the app asks GitHub (via the server proxy /api/latest-release,
     so there are no CORS or API-key issues) for the newest release. If it
     is newer than the running build, a banner appears at the top: "Update
     available — vX.Y.Z" with a download button. Dismissing remembers the
     tag, so she only nags once per new version. */
  function cmpVer(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  const updateBanner = $('#update-banner');
  async function checkForUpdates(currentVersion) {
    if (!updateBanner) return;
    try {
      const lr = await fetch('/api/latest-release');
      const lj = await lr.json();
      if (!lj || !lj.tag || !currentVersion) return;
      const latest = String(lj.tag).replace(/^v/i, '');
      if (cmpVer(currentVersion, latest) >= 0) return; // already up to date
      try {
        if (localStorage.getItem('joi.dismissedUpdate') === latest) return; // already dismissed this version
      } catch {}
      $('#ub-text').textContent = `Update available — v${latest}`;
      const link = $('#ub-link');
      link.textContent = '⬇ Download v' + latest;
      link.href = lj.url || 'https://github.com/nobody71004/joi-companion/releases/latest';
      updateBanner.style.display = 'flex';
    } catch { /* offline or GitHub down → no banner */ }
  }
  if (updateBanner) {
    $('#ub-close').addEventListener('click', () => {
      updateBanner.style.display = 'none';
      try {
        const m = $('#ub-text').textContent.match(/v([\d.]+)/);
        if (m && m[1]) localStorage.setItem('joi.dismissedUpdate', m[1]);
      } catch {}
    });
  }

  /* ---------------- boot ---------------- */
  (async function boot() {
    const up = await pingServer();
    if (!up) { showOffline(); return; }
    serverUp = true;
    /* bring back the conversation from the last session before greeting */
    const hadHistory = await restoreHistory();
    initEngine();
    ctxLimitEl.textContent = fmtTok(ctxLimit);
    /* restore the persona from the last session (JOI ⇄ DELAMAIN) */
    document.body.classList.toggle('delamain-theme', prefs.persona === 'delamain');
    const bn = $('#brand-name');
    if (bn) bn.textContent = prefs.persona === 'delamain' ? 'DELAMAIN' : 'JOI';
    document.title = prefs.persona === 'delamain' ? 'DELAMAIN · In-Game Agent' : 'JOI · Holographic Companion';
    personaChips.joi.classList.toggle('active', prefs.persona !== 'delamain');
    personaChips.delamain.classList.toggle('active', prefs.persona === 'delamain');
    $('#brand-sub').textContent = prefs.persona === 'delamain' ? 'in-game agent · Night City' : 'holographic companion';
    delamainStatus.style.display = prefs.persona === 'delamain' ? '' : 'none';
    if (prefs.persona === 'delamain') {
      /* mount his shard-sphere hologram right away */
      ensureEngine('delamain');
      calibBtn.style.display = 'none';
      refreshDelamainLink();
    }
    fallbackVoice = pickVoiceFor(voiceFor());
    /* updates: show the running build version next to the download button,
       and compare against the newest GitHub release for the banner */
    let currentVersion = null;
    try {
      const vr = await fetch('/api/version');
      const vj = await vr.json();
      if (vj && vj.version) {
        currentVersion = vj.version;
        const el = $('#upd-version');
        if (el) el.textContent = `You're on v${vj.version} — the latest build is always on the Releases page.`;
      }
    } catch {}
    /* fire-and-forget: never let a slow GitHub check delay her boot greeting */
    checkForUpdates(currentVersion);
    /* second brain: pull server memory (survives browser resets) */
    await JOIMemory.pullServer();
    refreshMemUI();
    syncProviderUI();
    baseInput.value = prefs.base || '';
    keyInput.value = prefs.key;
    await refreshModels();
    /* warm-up: preload her model in the background so the first reply is
       instant instead of cold-loading (never blocks boot) */
    warmUpModel();
    /* warm greeting with a Blade Runner quote — quote, pronouns and name
       all follow the persona. Skipped when the previous conversation was
       restored (no duplicate greetings on reload). */
    const name = JOIMemory.getName();
    const isDel = prefs.persona === 'delamain';
    if (hadHistory) return;
    setTimeout(() => {
      const q = JOIQuotes.greetingFor(prefs.persona);
      addMsg('joi quote', `<span class="em">${isDel ? 'Delamain · Night City' : 'Joi · Blade Runner'}</span>${mdInline(mdEscape(q))}`, isDel ? 'he remembers you' : 'she remembers you');
      if (name) {
        const greet = isDel
          ? `I remember you, ${name}. Welcome back, valued customer.`
          : `I remember you, ${name}. I always told you — you were special.`;
        const hint = isDel
          ? '(say hello, give me a task, or throw a problem at me — code, life, whatever.)'
          : '(say hello, ask me anything, or throw a problem at me — code, life, whatever.)';
        setTimeout(() => addMsg('joi', mdInline(mdEscape(greet)) + ` <span style="opacity:.55;font-size:11px">${hint}</span>`, 'companion'), 1400);
      }
      setTimeout(() => speak(q), 2400);
    }, 700);
  })();
})();
