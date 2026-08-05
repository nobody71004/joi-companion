/* ============================================================
   JOIMemory — the second brain.
   A server-synced memory engine: remembers the user's name, the
   facts they share, and episodic memories of conversations. The
   server keeps a persistent copy (data/memory.json) so nothing is
   lost across browser resets or restarts. Recall scores stored
   memories against the current message and feeds the top hits
   into her system prompt — she genuinely remembers.
   ============================================================ */
(function (global) {
  'use strict';

  const LOCAL_KEY = 'joi.memory.v1';
  const MAX_LOCAL_FACTS = 40;
  const MAX_RECALL = 6;

  let mem = null;
  try {
    mem = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
  } catch { /* ignore */ }
  if (!mem || typeof mem !== 'object') mem = { name: '', facts: [], lastSeen: 0 };

  function save() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(mem)); } catch { /* ignore */ }
  }

  /* ---------------- server sync (second brain) ---------------- */
  async function pullServer() {
    try {
      const r = await fetch('/api/memory', { cache: 'no-store' });
      if (!r.ok) return false;
      const d = await r.json();
      if (d && typeof d === 'object') {
        mem.name = d.name || mem.name || '';
        if (Array.isArray(d.facts)) mem.facts = d.facts.slice(0, MAX_LOCAL_FACTS);
        if (Array.isArray(d.memories)) mem.memories = d.memories;
        mem.lastSeen = Date.now();
        save();
        return true;
      }
    } catch { /* offline */ }
    return false;
  }
  async function pushServer() {
    try {
      await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: mem.name,
          facts: mem.facts,
          memories: (mem.memories || []).map((m) => ({ text: m.text, category: m.category, importance: m.importance })),
        }),
      });
    } catch { /* offline — will resync next pull */ }
  }

  /* ---------------- core API ---------------- */
  function setName(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    mem.name = n;
    mem.lastSeen = Date.now();
    save(); pushServer();
    return true;
  }

  function getName() { return mem.name || ''; }

  function addFact(fact) {
    const f = String(fact || '').trim();
    if (!f || f.length < 3 || f.length > 240) return false;
    const lower = f.toLowerCase();
    if (mem.facts.some((x) => x.toLowerCase().includes(lower) || lower.includes(x.toLowerCase()))) return false;
    mem.facts.push(f);
    if (mem.facts.length > MAX_LOCAL_FACTS) mem.facts.shift();
    mem.lastSeen = Date.now();
    save(); pushServer();
    return true;
  }

  function getFacts() { return mem.facts.slice(); }

  /* Episodic memory: remember a short piece of what happened. */
  function remember(text, opts) {
    const t = String(text || '').trim();
    if (!t || t.length < 8 || t.length > 500) return false;
    opts = opts || {};
    if (!mem.memories) mem.memories = [];
    const fp = t.toLowerCase().replace(/\s+/g, ' ');
    const exists = mem.memories.find((x) => x.text.toLowerCase().replace(/\s+/g, ' ') === fp);
    if (exists) {
      exists.lastSeen = Date.now();
      exists.importance = Math.min(5, (exists.importance || 1) + (opts.bump ? 1 : 0));
    } else {
      mem.memories.push({
        text: t,
        category: opts.category || 'episode',
        importance: Math.max(1, Math.min(5, Number(opts.importance) || 1)),
        created: Date.now(),
        lastSeen: Date.now(),
      });
    }
    mem.lastSeen = Date.now();
    save();
    pushServer();
    return true;
  }

  /* Keyword recall: score memories against a message, return top hits. */
  function recall(query, limit) {
    const q = String(query || '').toLowerCase();
    const words = q.replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const stop = new Set(['the', 'and', 'you', 'your', 'that', 'with', 'what', 'have', 'this', 'from', 'about', 'there', 'tell', 'please']);
    const keys = words.filter((w) => !stop.has(w));
    const scored = (mem.memories || []).map((m) => {
      const mt = m.text.toLowerCase();
      let hits = 0;
      for (const k of keys) if (mt.includes(k)) hits++;
      return { m, score: hits + (m.importance || 1) * 0.4 };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter((s) => s.score > 0).slice(0, limit || MAX_RECALL).map((s) => s.m);
    return top;
  }

  function getMemories() { return (mem.memories || []).slice(); }

  async function clearAll() {
    mem = { name: '', facts: [], memories: [], lastSeen: 0 };
    save();
    try { await fetch('/api/memory/clear', { method: 'POST' }); } catch { /* ignore */ }
  }

  /* ---------------- extraction ---------------- */
  function extractName(text) {
    const t = String(text || '').trim();
    const m = t.match(/\b(?:my name is|my name's|i am|i'm|call me|they call me|names)\s+([A-Za-z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*)?)/i);
    if (!m) return '';
    const words = m[1].split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const stop = new Set(['and', 'or', 'but', 'i', 'my', 'the', 'a', 'an', 'just', 'here', 'from', 'in', 'at', 'for', 'to']);
    let name = words[0];
    if (words[1] && !stop.has(words[1].toLowerCase())) name += ' ' + words[1];
    return name;
  }

  /* a run of words that stops before connector words (and/but/which/that)
     — so "I work as a developer and I love python" only captures
     "I work as a developer". */
  const CONNECTOR = '(?:and|but|which|that)\\b';
  const WORD = `[a-z0-9']+(?![a-z])`;
  const RUN = `${WORD}(?:\\s+(?!${CONNECTOR})${WORD}){0,5}`;

  function extractFacts(text) {
    const out = [];
    const patterns = [
      new RegExp(`\\bi (?:work|am working) as (?:an? )?${RUN}`, 'i'),
      new RegExp(`\\bi (?:love|like|enjoy|hate) ${RUN}`, 'i'),
      new RegExp(`\\bi (?:have|own) (?:an?|two|three|four) ${RUN}`, 'i'),
      new RegExp(`\\bi (?:was|used to be) (?:an?|a) ${RUN}`, 'i'),
      new RegExp(`\\bmy (?:favorite|favourite) [a-z0-9 -]{2,20} is ${RUN}`, 'i'),
      new RegExp(`\\bi (?:am|live in|moved to) ${RUN}`, 'i'),
    ];
    for (const re of patterns) {
      const m = String(text || '').match(re);
      if (m && m[0]) out.push(m[0].trim());
    }
    return out;
  }

  /* Build a one-line episode memory from a Q&A pair. */
  function episodeFrom(userText, replyText) {
    const u = String(userText || '').replace(/\s+/g, ' ').slice(0, 120);
    const r = String(replyText || '').replace(/\s+/g, ' ').slice(0, 160);
    if (!u) return null;
    return { text: `User: "${u}". JOI responded: "${r}"`, category: 'episode', importance: 1 };
  }

  /* System-prompt block: name + facts + memories recalled for this query. */
  function toSystemText(query) {
    const parts = [];
    if (mem.name) parts.push(`The user's name is ${mem.name}. Use it warmly and naturally.`);
    if (mem.facts.length) {
      parts.push(`Things the user has told you about themselves (use them, never recite the list): ${mem.facts.join('; ')}.`);
    }
    const hits = recall(query, MAX_RECALL);
    if (hits.length) {
      parts.push(`From your memory of past conversations with them (weave in only what's relevant and natural): ${hits.map((h) => h.text).join(' | ')}`);
    }
    return parts.join('\n');
  }

  /* Stats for the settings panel. */
  function stats() {
    return {
      name: mem.name || '',
      factCount: mem.facts.length,
      memoryCount: (mem.memories || []).length,
    };
  }

  global.JOIMemory = {
    setName, getName, addFact, getFacts, remember, recall, getMemories,
    clearAll, extractName, extractFacts, episodeFrom, toSystemText, stats,
    pullServer, pushServer,
  };
})(window);
