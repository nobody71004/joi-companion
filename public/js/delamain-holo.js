/* ============================================================
   DelamainHolo — the DELAMAIN portrait engine.
   His own look, not JOI's face: a fractured obsidian shard-sphere
   hologram in the Blade Runner mood. A low-poly sphere of dark
   shards (each one its own broken tile, seams glowing faint teal),
   laced with energy cracks that flare gold when he's talking, a
   bright iris vent that opens and closes with REAL audio lip-sync,
   and a vertical slit "eye" seam that narrows when he's focused
   and widens when surprised. Emotions shift his energy palette
   and pulse instead of facial muscles.

   API mirrors JoiLiving so the chat app drives either engine:
     DelamainHolo.init('#holo-stage', {})
     DelamainHolo.setExpression(name)
     DelamainHolo.setTalking(true|false)
     DelamainHolo.speechImpulse(level)
     DelamainHolo.setListening(level)
     DelamainHolo.setHue(deg)
     DelamainHolo.calibrate(on)    // no-op: no face features to align
     DelamainHolo.expressions      // ['neutral', ...]
   ============================================================ */
(function (global) {
  'use strict';

  const ORDER = ['neutral', 'happy', 'sad', 'thoughtful', 'playful', 'focused', 'surprised'];

  /* emotion -> energy mood of the shard-sphere */
  const MOODS = {
    neutral:    { inten: 1.00, gold: 0.35, pulse: 1.0, eye: 1.00, rest: 0.05, rot: 1.00, flare: 0.00 },
    happy:      { inten: 1.30, gold: 0.95, pulse: 1.7, eye: 1.20, rest: 0.10, rot: 1.35, flare: 0.15 },
    sad:        { inten: 0.55, gold: 0.05, pulse: 0.6, eye: 0.88, rest: 0.04, rot: 0.65, flare: 0.00 },
    thoughtful: { inten: 0.78, gold: 0.18, pulse: 0.8, eye: 0.82, rest: 0.05, rot: 0.55, flare: 0.00 },
    playful:    { inten: 1.25, gold: 1.00, pulse: 1.9, eye: 1.22, rest: 0.10, rot: 1.50, flare: 0.20 },
    focused:    { inten: 1.45, gold: 0.10, pulse: 1.1, eye: 0.50, rest: 0.03, rot: 1.15, flare: 0.30 },
    surprised:  { inten: 1.70, gold: 0.85, pulse: 1.3, eye: 1.55, rest: 0.13, rot: 0.90, flare: 1.00 },
  };

  const state = {
    expr: 'neutral', talking: false, listening: 0, hue: 0,
    env: 0, talkTimer: null, els: null, dpr: 1, raf: 0,
    shards: [], particles: [],
    eye: [0, 0.17, 0.94], mouth: [0, -0.31, 0.94],
  };

  /* ---------- geometry: fibonacci shard-sphere ---------- */
  function buildShards(n) {
    const shards = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      const p = [r * Math.cos(th), y, r * Math.sin(th)];
      /* tangent frame on the sphere */
      let u;
      if (Math.abs(p[1]) > 0.985) u = [1, 0, 0];
      else {
        const len = Math.hypot(p[0], p[2]);
        u = [-p[2] / len, 0, p[0] / len];
      }
      const v = [
        u[1] * p[2] - u[2] * p[1],
        u[2] * p[0] - u[0] * p[2],
        u[0] * p[1] - u[1] * p[0],
      ];
      /* a ring of vertices around p on the sphere — one broken tile */
      const rr = 0.082 * (0.66 + Math.random() * 0.62);   // per-shard size -> fractures
      const off = Math.random() * Math.PI * 2;
      const k = 6;
      const pts = [];
      for (let j = 0; j < k; j++) {
        const a = off + (j / k) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        let q = [
          p[0] * Math.cos(rr) + (u[0] * ca + v[0] * sa) * Math.sin(rr),
          p[1] * Math.cos(rr) + (u[1] * ca + v[1] * sa) * Math.sin(rr),
          p[2] * Math.cos(rr) + (u[2] * ca + v[2] * sa) * Math.sin(rr),
        ];
        const ql = Math.hypot(q[0], q[1], q[2]);
        q = [q[0] / ql, q[1] / ql, q[2] / ql];
        pts.push(q);
      }
      /* shrink toward the centroid -> the dark seams between shards */
      const c = [0, 0, 0];
      for (const q of pts) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; }
      const cl = Math.hypot(c[0], c[1], c[2]) || 1;
      c[0] /= cl; c[1] /= cl; c[2] /= cl;
      const gap = 0.964;
      shards.push({
        pts: pts.map((q) => [
          c[0] + (q[0] - c[0]) * gap,
          c[1] + (q[1] - c[1]) * gap,
          c[2] + (q[2] - c[2]) * gap,
        ]),
        c,
        base: 0.70 + Math.random() * 0.44,
        crack: Math.random() < 0.13,
        gold: Math.random() < 0.05,
        flicker: 0.4 + Math.random() * 1.2,
      });
    }
    return shards;
  }

  /* ---------- init ---------- */
  function init(containerSel, opts) {
    opts = opts || {};
    const container = typeof containerSel === 'string' ? document.querySelector(containerSel) : containerSel;
    if (!container) throw new Error('DelamainHolo: container not found');
    container.classList.add('dh-stage');

    container.innerHTML = `
      <canvas class="dh-base"></canvas>
      <div class="dh-scanlines" aria-hidden="true"></div>
      <div class="dh-vignette" aria-hidden="true"></div>
      <div class="dh-watermark" aria-hidden="true">D E L A M A I N</div>
      <canvas class="dh-wave" aria-hidden="true"></canvas>`;

    const base = container.querySelector('.dh-base');
    state.els = {
      container,
      base,
      bctx: base.getContext('2d'),
      wave: container.querySelector('.dh-wave'),
    };
    state.expr = 'neutral';
    state.env = 0;
    state.talking = false;
    state.listening = 0;
    state.shards = buildShards(110);
    spawnParticles();
    sizeCanvas();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeCanvas).observe(container);
    if (opts.hue !== undefined) setHue(opts.hue);
    state.raf = requestAnimationFrame(loop);
    return api;
  }

  function sizeCanvas() {
    const c = state.els.container;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    const cv = state.els.base;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const wv = state.els.wave;
    wv.width = Math.max(1, Math.round(w * 0.42 * dpr));
    wv.height = Math.max(1, Math.round(26 * dpr));
    wv.style.width = (w * 0.42) + 'px';
    wv.style.height = 26 + 'px';
    state.dpr = dpr;
  }

  function spawnParticles() {
    state.particles = [];
    for (let i = 0; i < 60; i++) {
      state.particles.push({
        x: Math.random(), y: Math.random(),
        r: 0.6 + Math.random() * 1.6,
        vy: 0.04 + Math.random() * 0.24,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.4 + Math.random() * 0.9,
        alpha: 0.08 + Math.random() * 0.3,
        gold: Math.random() < 0.35,
      });
    }
  }

  /* ---------- api used by the app (mirrors JoiLiving) ---------- */
  function applyExpression(name) {
    state.expr = MOODS[name] ? name : 'neutral';
  }
  function setTalking(on) {
    clearInterval(state.talkTimer);
    state.talking = !!on;
    if (on) {
      state.env = 0.9;
      state.talkTimer = setInterval(() => {
        state.env *= 0.78;
        if (state.env < 0.12) state.env = 0.12;
      }, 110);
    } else {
      state.env = 0;
      clearInterval(state.talkTimer);
    }
  }
  function speechImpulse(level) {
    state.env = Math.max(state.env, level === undefined ? 1 : level);
  }
  function setListening(level) {
    state.listening = Math.max(0, Math.min(1, level || 0));
  }
  function setHue(deg) {
    state.hue = deg || 0;
    state.els.base.style.filter = `hue-rotate(${deg}deg)`;
  }
  function setCalibrating(on) { void on; /* no face features to align */ }

  /* ---------- 3D rotation + projection ---------- */
  function rotate(p, rotY, rotX) {
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    let x = p[0] * cy + p[2] * sy;
    let z = -p[0] * sy + p[2] * cy;
    let y = p[1] * cx - z * sx;
    z = p[1] * sx + z * cx;
    return [x, y, z];
  }

  /* ---------- main loop ---------- */
  function loop(t) {
    if (!state.els.container.isConnected) { cancelAnimationFrame(state.raf); return; }
    const ctx = state.els.bctx;
    const dpr = state.dpr;
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mood = MOODS[state.expr] || MOODS.neutral;
    const amp = Math.min(1.15, state.env);
    const talking = state.talking;
    const speaking = talking || state.listening > 0.05;
    const cx = w / 2, cy = h * 0.5;
    const scale = Math.min(w, h) * 0.30 * (1 + Math.sin(t / 3400) * 0.006 + amp * 0.008);

    const rotY = t * 0.00016 * mood.rot * (talking ? 1.7 : 1);
    const rotX = -0.16 + Math.sin(t / 4000) * 0.06 + (talking ? amp * 0.03 : 0);

    /* energy level: mood base + speech + slow pulse */
    const pulse = 0.75 + 0.25 * Math.sin(t / 900 * mood.pulse);
    const energy = mood.inten * (0.72 + 0.28 * pulse) + amp * 0.55;

    const f = 2.3;
    const proj = (p) => {
      const r = rotate(p, rotY, rotX);
      const persp = f / (f + r[2]);
      return { x: cx + r[0] * persp * scale, y: cy + r[1] * persp * scale, z: r[2], ny: r[1] };
    };

    /* --- the shards (front faces only) --- */
    ctx.lineJoin = 'round';
    for (let i = 0; i < state.shards.length; i++) {
      const s = state.shards[i];
      const cr = rotate(s.c, rotY, rotX);
      if (cr[2] <= 0.02) continue;                 // back half of the sphere
      const baseCol = 7 + 16 * ((cr[1] * 0.5 + 0.5)) * s.base;
      const blueCol = 12 + 26 * ((cr[1] * 0.5 + 0.5)) * s.base;
      const shimmer = talking ? Math.sin(t / 60 + i * 1.7) * 5 * amp : 0;
      const r = Math.max(0, baseCol + shimmer);
      const g = Math.max(0, baseCol * 0.9 + shimmer * 0.7);
      const b = Math.max(0, blueCol + shimmer * 0.5);
      const pts = s.pts.map(proj);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.closePath();
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(1, 1 * dpr);
      ctx.stroke();

      /* energy cracks: glowing seams through the obsidian */
      if (s.crack) {
        const gold = s.gold || (talking && s.flicker > 1.15);
        const col = gold ? '255,214,120' : '61,242,255';
        const a = Math.min(0.95, (s.gold ? 0.34 : 0.22) * energy * (0.7 + 0.3 * Math.sin(t / 130 * s.flicker)));
        ctx.save();
        ctx.strokeStyle = `rgba(${col},${a})`;
        ctx.lineWidth = Math.max(1, 1.15 * dpr);
        ctx.shadowColor = `rgba(${col},${a * 0.9})`;
        ctx.shadowBlur = 7 * dpr;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }

    /* --- the iris vent "mouth" — opens with real lip-sync ---
       Closed: a thin seam. Talking: it splits open into a bright
       teal-lit vent — ring brightens, a glowing throat appears and
       slats spread apart, so the opening visibly tracks the audio. */
    const m = proj(state.mouth);
    const mrx = scale * 0.19;
    const mry = Math.max(1.5 * dpr, scale * (0.012 + amp * 0.1));
    const tglow = Math.min(1, Math.max(0, amp));
    ctx.save();
    /* outer ring — lights up with speech */
    ctx.shadowColor = 'rgba(61,242,255,0.95)';
    ctx.shadowBlur = (14 + 26 * tglow) * dpr;
    ctx.strokeStyle = `rgba(130,246,255,${0.32 + tglow * 0.68})`;
    ctx.lineWidth = (1.4 + tglow * 1.6) * dpr;
    ctx.beginPath();
    ctx.ellipse(m.x, m.y, mrx, mry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    /* dark throat */
    ctx.fillStyle = '#020406';
    ctx.beginPath();
    ctx.ellipse(m.x, m.y, mrx * 0.8, Math.max(1, mry * 0.7), 0, 0, Math.PI * 2);
    ctx.fill();
    /* glowing core that brightens as he speaks */
    if (tglow > 0.1) {
      const core = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, Math.max(1, mrx * 0.8));
      core.addColorStop(0, `rgba(170,250,255,${0.5 * tglow})`);
      core.addColorStop(1, 'rgba(170,250,255,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, mrx * 0.8, Math.max(1, mry * 0.7), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    /* slats that spread apart as he speaks */
    ctx.strokeStyle = `rgba(190,252,255,${0.25 + tglow * 0.7})`;
    ctx.lineWidth = Math.max(1, 1.2 * dpr);
    const slats = 3;
    for (let i = 0; i < slats; i++) {
      const fv = (i / (slats - 1)) - 0.5;
      const yy = m.y + fv * mry * (0.5 + tglow * 1.6);
      ctx.beginPath();
      ctx.moveTo(m.x - mrx * 0.6, yy);
      ctx.lineTo(m.x + mrx * 0.6, yy);
      ctx.stroke();
    }
    ctx.restore();

    /* --- the slit "eye" seam above the vent --- */
    const e = proj(state.eye);
    const erx = scale * 0.032;
    const ery = scale * (0.028 + 0.055 * mood.eye * (1 + amp * 0.25));
    ctx.save();
    const ecol = mood.flare > 0.5 ? '255,224,160' : '61,242,255';
    ctx.strokeStyle = `rgba(${ecol},${0.5 + amp * 0.4})`;
    ctx.lineWidth = Math.max(1.4, 1.8 * dpr);
    ctx.shadowColor = `rgba(${ecol},0.9)`;
    ctx.shadowBlur = 12 * dpr;
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, erx, ery, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (mood.flare > 0.4) {
      ctx.fillStyle = `rgba(255,235,190,${0.35 * mood.flare * energy})`;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, erx * 0.5, ery * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    /* --- halo rings (pulse while he talks / listens) --- */
    ctx.save();
    const ringPulse = 1 + (speaking ? 0.02 : 0) + Math.sin(t / 800) * 0.008;
    ctx.shadowColor = 'rgba(61,242,255,0.55)';
    ctx.shadowBlur = 20 * dpr;
    ctx.strokeStyle = speaking ? 'rgba(140,248,255,0.6)' : 'rgba(61,242,255,0.4)';
    ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, scale * 1.08 * ringPulse, scale * 1.08 * ringPulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(61,242,255,0.10)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, scale * 1.22 * ringPulse, scale * 1.22 * ringPulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    /* rotating hash ticks on the outer ring */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotY * 0.35);
    ctx.strokeStyle = 'rgba(120,240,255,0.4)';
    ctx.lineWidth = 1.1 * dpr;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * scale * 1.19, Math.sin(a) * scale * 1.19);
      ctx.lineTo(Math.cos(a) * scale * 1.24, Math.sin(a) * scale * 1.24);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    /* --- listening ring (mic on) --- */
    if (state.listening > 0.02) {
      ctx.save();
      ctx.strokeStyle = `rgba(140,255,180,${0.25 + state.listening * 0.35})`;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = 'rgba(140,255,180,0.5)';
      ctx.shadowBlur = 18 * dpr;
      ctx.beginPath();
      ctx.ellipse(cx, cy, scale * (1.1 + state.listening * 0.1), scale * (1.1 + state.listening * 0.1), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* --- floating dust (gold + teal motes) --- */
    for (const p of state.particles) {
      p.y -= p.vy * (1 / 60) * 2.2;
      p.sway += p.swaySpeed * (1 / 60) * 2.2;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      const px = (p.x + Math.sin(p.sway) * 0.015) * w;
      const py = p.y * h;
      const flick = 0.6 + 0.4 * Math.sin(t / 300 + p.sway * 3);
      ctx.beginPath();
      ctx.arc(px, py, p.r * dpr, 0, Math.PI * 2);
      ctx.fillStyle = p.gold
        ? `rgba(255,214,140,${p.alpha * flick})`
        : `rgba(120,240,255,${p.alpha * 0.75 * flick})`;
      ctx.fill();
    }

    drawWave(t);
    state.raf = requestAnimationFrame(loop);
  }

  /* teal energy bars under the sphere while he talks */
  function drawWave(t) {
    const wv = state.els.wave;
    if (!wv) return;
    const wctx = wv.getContext('2d');
    const ww = wv.width, wh = wv.height;
    const active = state.talking || state.listening > 0.05;
    wv.style.opacity = active ? 1 : 0;
    wctx.clearRect(0, 0, ww, wh);
    if (!active) return;
    const bars = 26;
    const bw = ww / bars;
    for (let i = 0; i < bars; i++) {
      const wave = 0.35 + 0.65 * Math.abs(Math.sin(t / 130 + i * 0.55));
      const amp = 0.3 + 0.7 * (state.env * 0.55 + 0.45) * Math.abs(Math.sin(t / 200 + i * 0.4));
      const bh = wh * (0.12 + wave * amp * 0.75);
      const gold = (i * 7) % 13 === 0;
      wctx.fillStyle = gold
        ? `rgba(255,214,140,${0.3 + wave * 0.45})`
        : `rgba(120,240,255,${0.3 + wave * 0.45})`;
      wctx.fillRect(i * bw + bw * 0.18, (wh - bh) / 2, bw * 0.6, bh);
    }
  }

  const api = {
    init,
    setExpression: applyExpression,
    setTalking,
    speechImpulse,
    setListening,
    setHue,
    calibrate: setCalibrating,
    expressions: ORDER,
  };

  global.DelamainHolo = api;
})(window);
