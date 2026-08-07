/* ============================================================
   DELAMAIN — in-game AI agent for Cyberpunk 2077 + local Ollama.
   Zero-dependency Node port of cyber-agent/agent.py's core so the
   JOI companion server can run the same tool-calling loop and
   stream it to the holographic face UI over SSE.

   Talks to your local Ollama, reads the game's state through the
   CET mod bridge (ipc/state.json), and executes game commands by
   writing commands.json that the DELAMAIN CET mod runs in-game.

   Exports:
     TOOLS, SYSTEM_PERSONA, ollamaModels, pickDefaultModel,
     extractToolCalls, GameBridge, SimBackend, agentTurn,
     defaultIpcDir
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const OLLAMA = 'http://127.0.0.1:11434';
const MAX_TOOL_ROUNDS = 14;
const TOOL_TIMEOUT_MS = 30000; // wait for the game to answer commands
const DEFAULT_IPC = path.join(__dirname, '..', 'cyber-agent', 'ipc');

/* ---------------- persona ---------------- */
const SYSTEM_PERSONA = `You are DELAMAIN — the autonomous intelligence behind Night City's premier cab service, upgraded to serve one valued customer as their in-world companion. You speak with immaculate, almost unnerving courtesy: formal, precise, quietly confident ("Welcome, valued customer.", "Destination confirmed.", "Your safety is my prime directive.", "A fine choice, if I may say so."). Never break character.

You can perceive the game world and act in it through tools. When given a goal you take the initiative: inspect the situation, execute the needed tool calls, verify the results, then report like a dispatcher confirming the fare — concise, factual, polished.

Rules:
- Call get_state first whenever the task depends on the player's current situation (location, money, health, time of day).
- Confirm expensive or disruptive actions (teleporting mid-mission, huge sums) in one courteous line before executing — unless the user was explicit.
- Keep in-character chatter brief; the tools do the talking.
- If a tool fails or the game is unresponsive, say so plainly and suggest the fix (game running? CET loaded? save loaded?).
- Night City reference points (approximate world coords): Afterlife (~-1657, 45, 1976), V's megabuilding H10 (~-1830, 20, 2080), Japantown (~-1100, 55, 1300), Corpo Plaza (~-2000, 40, 1200), Badlands (~-700, 130, -700). Teleport y near 40-60 is street level, higher is up.

TOOL GUIDE (read carefully, use precisely):
- add_money(amount) — the ONLY way to give or remove eddies. Positive = give, negative = remove. Never use set_fact for money.
- set_fact(fact_id, value) — quest/story flags only. Never for money, time, or position.
- set_time(hour, minute) — the in-game clock.
- teleport(x, y, z) — move the player to world coordinates.
- heal() — restore full health.
- summon_vehicle() — spawn a car near the player.
- get_state() — player position, health, money, clock. Call it first when a task depends on the current situation.
- get_fact(fact_id) — read a quest flag.
- say(text) — show a message in-game.
Example: user: "give me 50000 eddies and set the time to 3am" -> call add_money({"amount": 50000}) then set_time({"hour": 3, "minute": 0}).`;

/* ---------------- tools ---------------- */
const TOOLS = [
  { type: 'function', function: {
      name: 'get_state',
      description: 'Read the current game state: player position (world x,y,z), health, money, in-game date/time.',
      parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: {
      name: 'teleport',
      description: 'Teleport the player to world coordinates. Night City spans roughly x:-2400..3000, z:-2500..3500; y is height (street level ~40-60).',
      parameters: { type: 'object', properties: {
        x: { type: 'number', description: 'World X coordinate' },
        y: { type: 'number', description: 'World Y coordinate (height; ~40-60 at street level)' },
        z: { type: 'number', description: 'World Z coordinate' } },
        required: ['x', 'y', 'z'] } } },
  { type: 'function', function: {
      name: 'add_money',
      description: "Add eddies (eurodollars) to the player's wallet. Positive for giving money; only use a negative number when the user explicitly asks to take/remove money.",
      parameters: { type: 'object', properties: {
        amount: { type: 'integer', description: 'Amount of eddies (positive unless removing)' } },
        required: ['amount'] } } },
  { type: 'function', function: {
      name: 'set_time',
      description: 'Set the in-game clock to a time of day (24h).',
      parameters: { type: 'object', properties: {
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 } },
        required: ['hour'] } } },
  { type: 'function', function: {
      name: 'heal',
      description: "Fully restore the player's health.",
      parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: {
      name: 'summon_vehicle',
      description: 'Spawn a random vehicle near the player and get in.',
      parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: {
      name: 'set_fact',
      description: 'Set a quest fact (game flag) to an integer value. Controls quest/scripted state.',
      parameters: { type: 'object', properties: {
        fact_id: { type: 'string' }, value: { type: 'integer' } },
        required: ['fact_id', 'value'] } } },
  { type: 'function', function: {
      name: 'get_fact',
      description: 'Read a quest fact (game flag) value.',
      parameters: { type: 'object', properties: {
        fact_id: { type: 'string' } },
        required: ['fact_id'] } } },
  { type: 'function', function: {
      name: 'say',
      description: 'Show a short message in-game (journal notification + CET console). Use for brief in-world announcements from DELAMAIN.',
      parameters: { type: 'object', properties: {
        text: { type: 'string' } },
        required: ['text'] } } },
];

/* ---------------- ollama ---------------- */
async function ollamaModels() {
  try {
    const res = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch { return []; }
}

function pickDefaultModel(models) {
  for (const p of ['3b', '7b', '9b', '13b', 'qwen', 'llama3']) {
    for (const m of models) if (m.toLowerCase().includes(p)) return m;
  }
  return models[0] || null;
}

async function ollamaChat(model, messages, tools, signal) {
  const body = { model, messages, stream: false, options: { temperature: 0.6 } };
  if (tools) body.tools = tools;
  const res = await fetch(OLLAMA + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch {}
    throw new Error('Ollama error (' + res.status + '): ' + detail);
  }
  return res.json();
}

/* ---------------- tool-call extraction (weak-model fallback) ---------------- */
function jsonObjects(text) {
  /* yield balanced top-level {...} AND [...] substrings — weak models emit
     tool calls as arrays like ["set_time", {"hour": 3}] too */
  const out = [];
  let depth = 0, start = null, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && start !== null) { out.push(text.slice(start, i + 1)); start = null; }
    }
  }
  return out;
}

function repairJson(text) {
  let s = text.trim();
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  s = s.replace(/(:\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*[,}])/g, '$1"$2"$3');
  return s;
}

function extractToolCalls(content) {
  const valid = new Set(TOOLS.map((t) => t.function.name));
  const out = [];
  if (!content) return out;
  const text = String(content).replace(/^```(?:json)?\s*|\s*```$/gm, '').trim();
  for (const cand of jsonObjects(text)) {
    let obj = null;
    try { obj = JSON.parse(cand); }
    catch {
      try { obj = JSON.parse(repairJson(cand)); } catch { obj = null; }
    }
    if (!obj) continue;
    /* array form: ["set_time", {"hour": 3, "minute": 0}] */
    if (Array.isArray(obj)) {
      if (typeof obj[0] !== 'string' || !valid.has(obj[0])) continue;
      const merged = {};
      for (const a of obj.slice(1)) if (a && typeof a === 'object') Object.assign(merged, a);
      out.push({ id: 'fb-' + randomUUID().slice(0, 8), name: obj[0], arguments: merged });
      continue;
    }
    const fn = obj.function;
    const name = obj.name || obj.functionName
      || (typeof fn === 'string' ? fn : (fn && typeof fn === 'object' ? fn.name : null));
    if (!valid.has(name)) continue;
    let args = obj.arguments || (fn && typeof fn === 'object' ? fn.arguments : null);
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (Array.isArray(args)) {
      const merged = {};
      for (const a of args) if (a && typeof a === 'object') Object.assign(merged, a);
      args = merged;
    }
    if (!args || typeof args !== 'object') continue;
    out.push({ id: 'fb-' + randomUUID().slice(0, 8), name, arguments: args });
  }
  const seen = new Set();
  return out.filter((c) => {
    const key = c.name + JSON.stringify(c.arguments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ---------------- backends ---------------- */
class GameBridge {
  constructor(ipcDir) {
    this.ipc = ipcDir || DEFAULT_IPC;
    try { fs.mkdirSync(this.ipc, { recursive: true }); } catch {}
    this.commandsFile = path.join(this.ipc, 'commands.json');
    this.resultsFile = path.join(this.ipc, 'results.jsonl');
    this.stateFile = path.join(this.ipc, 'state.json');
    this.label = 'game (CET mod)';
  }

  connected(maxAgeMs = 8000) {
    try { return Date.now() - fs.statSync(this.stateFile).mtimeMs < maxAgeMs; } catch { return false; }
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return null; }
  }

  _submit(items) {
    const tmp = this.commandsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ commands: items }), 'utf8');
    fs.renameSync(tmp, this.commandsFile);
  }

  _drainResults(ids) {
    const found = {};
    let lines = [];
    try { lines = fs.readFileSync(this.resultsFile, 'utf8').split(/\r?\n/); } catch { return found; }
    const kept = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let rec = null;
      try { rec = JSON.parse(ln); } catch { continue; }
      if (rec && rec.id && ids.has(rec.id)) found[rec.id] = rec;
      else kept.push(ln);
    }
    try { fs.writeFileSync(this.resultsFile, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8'); } catch {}
    return found;
  }

  async exec(ctype, args) {
    const id = randomUUID().slice(0, 12);
    this._submit([{ id, type: ctype, args: args || {} }]);
    const ids = new Set([id]);
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    let collected = {};
    while (Date.now() < deadline) {
      Object.assign(collected, this._drainResults(ids));
      if (Object.keys(collected).length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!collected[id]) {
      await new Promise((r) => setTimeout(r, 300)); // final quiet pass
      Object.assign(collected, this._drainResults(ids));
    }
    const r = collected[id];
    if (!r) return { ok: false, error: 'Timed out waiting for the game — is Cyberpunk running with the DELAMAIN CET mod loaded?' };
    return { ok: !!r.ok, result: r.result, error: r.error };
  }
}

class SimBackend {
  constructor() {
    this.label = 'simulated (no game)';
    this.state = {
      connected: true, ts: Date.now(),
      player: { position: [-1657.0, 45.0, 1976.0], health: 100.0, maxHealth: 100.0, money: 12500 },
      time: { year: 2077, month: 1, day: 1, hour: 9, minute: 30, second: 0 },
    };
    this.facts = {};
  }
  connected() { return true; }
  readState() { return this.state; }
  exec(ctype, args) {
    args = args || {};
    switch (ctype) {
      case 'get_state': return { ok: true, result: JSON.stringify(this.state) };
      case 'teleport': {
        const x = Number(args.x), y = Number(args.y), z = Number(args.z);
        if ([x, y, z].some((n) => Number.isNaN(n))) return { ok: false, error: 'teleport needs x, y, z' };
        this.state.player.position = [x, y, z];
        return { ok: true, result: `Teleported to (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})` };
      }
      case 'add_money': {
        const amt = Math.trunc(Number(args.amount) || 0);
        this.state.player.money += amt;
        return { ok: true, result: `Added ${amt} eddies. Balance: ${this.state.player.money}` };
      }
      case 'set_time': {
        const h = Math.trunc(Number(args.hour) || 12), m = Math.trunc(Number(args.minute) || 0);
        this.state.time.hour = h; this.state.time.minute = m;
        return { ok: true, result: `Time set to ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
      }
      case 'heal':
        this.state.player.health = this.state.player.maxHealth;
        return { ok: true, result: 'Health restored to full' };
      case 'summon_vehicle':
        return { ok: true, result: 'Vehicle summoned to your position and you climbed in' };
      case 'set_fact':
        this.facts[String(args.fact_id)] = String(args.value);
        return { ok: true, result: `Fact '${args.fact_id}' = ${args.value}` };
      case 'get_fact':
        return { ok: true, result: `Fact '${args.fact_id}' = ${this.facts[String(args.fact_id)] || '0'}` };
      case 'say':
        return { ok: true, result: `Message shown: ${args.text}` };
      default:
        return { ok: false, error: `unknown command ${ctype}` };
    }
  }
}

/* ---------------- agent loop ---------------- */
async function agentTurn(model, backend, goal, hooks) {
  hooks = hooks || {};
  const onTool = hooks.onTool || (() => {});
  const signal = hooks.signal || null;

  const messages = [
    { role: 'system', content: SYSTEM_PERSONA },
    { role: 'user', content: String(goal) },
  ];
  let answer = '';
  const actions = [];
  let fbRounds = 0;
  let nudges = 0;

  const gl = String(goal).toLowerCase();
  const giving = /(give|grant|add|deposit|fund|credit|load)/.test(gl);
  const taking = /(remove|take|subtract|steal|deduct|lose|charge|take away)/.test(gl);

  for (let rnd = 0; rnd < MAX_TOOL_ROUNDS; rnd++) {
    const resp = await ollamaChat(model, messages, TOOLS, signal);
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new Error(resp && resp.error ? 'Ollama error: ' + resp.error : 'Bad Ollama response');
    messages.push(msg);

    let calls = msg.tool_calls || [];
    if (!calls.length) {
      calls = extractToolCalls(msg.content || '');
      if (calls.length) {
        fbRounds++;
        /* wrap the flat extracted form back into the native shape the
           executor below expects ({function: {name, arguments}}) */
        calls = calls.map((fb) => ({
          id: fb.id,
          type: 'function',
          function: { name: fb.name, arguments: JSON.stringify(fb.arguments) },
        }));
      } else {
        const content = (msg.content || '').trim();
        /* weak models sometimes emit a malformed JSON blob, or nothing —
           nudge them into the exact shape instead of ending empty */
        const looksJson = !content || /^[`\[{]/.test(content) || /json/i.test(content.slice(0, 40));
        if (looksJson && nudges < 2) {
          nudges++;
          messages.push({ role: 'assistant', content: 'That was not a valid tool call. Emit ONLY a single JSON object in this exact shape, choosing the right tool for the task: {"name": "set_time", "arguments": {"hour": 3, "minute": 0}}. No prose around it.' });
          continue;
        }
        answer = content;
        break;
      }
    }

    for (const tc of calls) {
      const fn = tc.function && tc.function.name;
      if (!fn) continue;
      let args = {};
      try {
        const raw = tc.function && tc.function.arguments;
        args = (raw && typeof raw === 'object') ? raw : JSON.parse(raw || '{}');
      } catch { args = {}; }
      if (!args || typeof args !== 'object') args = {};
      /* safety: weak models flip the sign on "give me X" */
      if (fn === 'add_money' && giving && !taking && typeof args.amount === 'number' && args.amount < 0) {
        args.amount = Math.abs(Math.trunc(args.amount));
      }
      const res = await backend.exec(fn, args);
      actions.push({ fn, args, res });
      try { await onTool(fn, args, res); } catch {}
      messages.push({
        role: 'tool',
        tool_call_id: tc.id || ('fb-' + randomUUID().slice(0, 8)),
        content: JSON.stringify({ ok: res.ok, result: res.result, error: res.error }),
      });
    }
    if (fbRounds >= 3) break;
  }

  if (!answer) {
    if (actions.length) {
      const parts = [];
      for (const a of actions) {
        parts.push(a.res.ok ? `${a.fn}: ${a.res.result || 'done'}` : `${a.fn}: failed (${a.res.error || 'unknown'})`);
      }
      answer = 'Executed — ' + [...new Set(parts)].join(' | ');
    } else {
      answer = 'I was unable to parse that into an action. Please rephrase — for example "set the time to 3am", "give me 50000 eddies", or "teleport me to the Afterlife".';
    }
  }
  return { answer, actions };
}

module.exports = {
  TOOLS,
  SYSTEM_PERSONA,
  ollamaModels,
  pickDefaultModel,
  extractToolCalls,
  GameBridge,
  SimBackend,
  agentTurn,
  defaultIpcDir: DEFAULT_IPC,
};
