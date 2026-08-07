/* ============================================================
   JoiLiving — living portrait engine v3.
   Your render IS the face. In Align mode you draw a loop around
   each feature (left eye, right eye, both brows, mouth, nose);
   the engine keeps the EXACT drawn path — no oval fitting — and
   the animated parts (eyelids, lips, brows, nose shading) follow
   that precise shape. Blinks, breathing, head tilt, expression
   grading and audio lip-sync all ride on top.

   Page usage:
     JoiLiving.init('#holo-stage', { src: 'img/images.jpg', preset: 'images' })
     JoiLiving.setExpression(name)
     JoiLiving.setTalking(true|false)
     JoiLiving.speechImpulse(level)
     JoiLiving.setListening(level)
     JoiLiving.setHue(deg)
     JoiLiving.calibrate(true|false)   // Align mode: draw feature loops
   ============================================================ */
(function (global) {
  'use strict';

  const STORE_KEY = 'joi.calibration2';

  /* ---------- feature ellipse presets (fractions of the image) ---------- */
  const PRESETS = {
    images: {
      /* measured on the render: dark-cell + lip-tone detection,
         fitted for the 3/4 pose (far eye smaller + higher) */
      eyeL:  { cx: 0.440, cy: 0.300, rx: 0.030, ry: 0.017 },
      eyeR:  { cx: 0.620, cy: 0.320, rx: 0.026, ry: 0.015 },
      browL: { cx: 0.440, cy: 0.262, rx: 0.033, ry: 0.010 },
      browR: { cx: 0.620, cy: 0.282, rx: 0.028, ry: 0.009 },
      mouth: { cx: 0.530, cy: 0.418, rx: 0.032, ry: 0.016 },
      nose:  { cx: 0.500, cy: 0.356, rx: 0.020, ry: 0.028 },
      faceCx: 0.50, faceCy: 0.36,
    },
  };

  const FEATURES = [
    { key: 'eyeL',  label: 'L eye' },
    { key: 'eyeR',  label: 'R eye' },
    { key: 'browL', label: 'L brow' },
    { key: 'browR', label: 'R brow' },
    { key: 'mouth', label: 'Mouth' },
    { key: 'nose',  label: 'Nose' },
  ];

  /* ---------- expressions ----------
     Brows have per-emotion poses: browL/browR = lift of each brow,
     browTilt > 0 furrows (inner ends drop), browTilt < 0 sorrows
     (inner ends rise). Anchor brows freezes every pose. */
  const EXPRESSIONS = {
    neutral:    { smile: 0.18, open: 0.06, lid: 0.06,  browL: 0.0, browR: 0.0, browTilt: 0,    tilt: 0.4,  filt: 'brightness(1.03) saturate(1.05)', tint: 'rgba(255,200,160,0.05)' },
    happy:      { smile: 0.85, open: 0.20, lid: 0.22,  browL: 0.9, browR: 0.9, browTilt: 0,    tilt: 1.4,  filt: 'brightness(1.12) saturate(1.25)', tint: 'rgba(255,180,130,0.14)' },
    sad:        { smile: -0.7, open: 0.05, lid: 0.40,  browL: 0.4, browR: 0.4, browTilt: -2.6, tilt: -1.6, filt: 'brightness(0.80) saturate(0.62) contrast(1.05)', tint: 'rgba(60,80,160,0.20)' },
    thoughtful: { smile: -0.15, open: 0.05, lid: 0.32, browL: 1.5, browR: 0.3, browTilt: 0.4,  tilt: -2.2, filt: 'brightness(0.90) saturate(0.85)', tint: 'rgba(130,100,200,0.14)' },
    playful:    { smile: 0.60, open: 0.14, lid: 0.18,  browL: 2.1, browR: 0.3, browTilt: 0,    tilt: 2.8,  filt: 'brightness(1.08) saturate(1.22)', tint: 'rgba(255,150,200,0.16)' },
    focused:    { smile: 0.0,  open: 0.04, lid: 0.42,  browL: -0.4, browR: -0.4, browTilt: 3.2, tilt: -0.6, filt: 'brightness(1.0) saturate(1.05) contrast(1.08)', tint: 'rgba(30,45,90,0.12)' },
    surprised:  { smile: 0.10, open: 0.72, lid: -0.04, browL: 3.0, browR: 3.0, browTilt: 0,    tilt: 0,    filt: 'brightness(1.08)', tint: 'rgba(255,230,210,0.10)' },
  };
  const ORDER = ['neutral', 'happy', 'sad', 'thoughtful', 'playful', 'focused', 'surprised'];

  /* ---------- state ---------- */
  const state = {
    expr: 'neutral', talking: false, listening: 0, hue: 0,
    env: 0, talkBrow: 0, talkTimer: null, blinkTimer: null,
    blink: 0, gazeX: 0, gazeY: 0, lastPointer: 0,
    img: null, els: null, preset: null, drawn: false,
    colors: { skin: null, lip: null, dark: null },
    raf: 0, particles: [],
    calibrating: false, activeFeature: 'eyeL',
    stroke: null, strokePts: [],
  };

  function loadCalibration() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (c) {
        for (const f of FEATURES) {
          const saved = c[f.key];
          if (saved && state.preset[f.key]) Object.assign(state.preset[f.key], saved);
        }
        if (typeof c.anchorBrows === 'boolean') state.anchorBrows = c.anchorBrows;
      }
    } catch {}
  }
  function saveCalibration() {
    try {
      const out = { anchorBrows: state.anchorBrows };
      for (const f of FEATURES) out[f.key] = Object.assign({}, state.preset[f.key]);
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {}
  }

  /* ---------- init ---------- */
  function init(containerSel, opts) {
    opts = opts || {};
    const container = typeof containerSel === 'string' ? document.querySelector(containerSel) : containerSel;
    if (!container) throw new Error('JoiLiving: container not found');
    container.classList.add('jf-stage');

    container.innerHTML = `
      <canvas class="jf-fx"></canvas>
      <canvas class="jf-base"></canvas>
      <canvas class="jf-wave" aria-hidden="true"></canvas>
      <div class="jf-scanlines" aria-hidden="true"></div>
      <div class="jf-vignette" aria-hidden="true"></div>
      <div class="jf-watermark" aria-hidden="true">J O I</div>
      <div class="jf-editbar" aria-hidden="true">
        <span class="jf-editbar-title">ALIGN FEATURES — draw a loop around each part</span>
        <div class="jf-editbar-chips"></div>
        <button type="button" class="jf-editbar-anchor">⏸ Anchor brows</button>
        <button type="button" class="jf-editbar-done">✓ Done</button>
      </div>`;

    const fx = container.querySelector('.jf-fx');
    const base = container.querySelector('.jf-base');
    state.els = {
      container, fx, base,
      fctx: fx.getContext('2d'),
      bctx: base.getContext('2d'),
      wave: container.querySelector('.jf-wave'),
      editbar: container.querySelector('.jf-editbar'),
      chips: container.querySelector('.jf-editbar-chips'),
    };

    const presetName = opts.preset || 'images';
    state.preset = Object.assign({}, PRESETS[presetName] || PRESETS.images);
    for (const k of FEATURES) state.preset[k] = Object.assign({}, (PRESETS[presetName] || PRESETS.images)[k]);
    state.anchorBrows = false;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { state.img = img; sizeCanvas(); sampleColors(); scheduleBlink(); };
    img.onerror = () => console.error('JoiLiving: failed to load', opts.src);
    img.src = opts.src || 'img/images.jpg';

    sizeCanvas();
    loadCalibration();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeCanvas).observe(container);
    spawnParticles();
    if (opts.hue !== undefined) setHue(opts.hue);

    buildChips();
    wirePointer();
    state.raf = requestAnimationFrame(loop);
    return api;
  }

  function buildChips() {
    const wrap = state.els.chips;
    wrap.innerHTML = '';
    FEATURES.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jf-editbar-chip' + (f.key === state.activeFeature ? ' active' : '');
      b.textContent = f.label;
      b.addEventListener('click', () => {
        state.activeFeature = f.key;
        wrap.querySelectorAll('.jf-editbar-chip').forEach((c) => c.classList.toggle('active', c === b));
      });
      wrap.appendChild(b);
    });
    const anchor = state.els.editbar.querySelector('.jf-editbar-anchor');
    if (anchor) {
      const sync = () => {
        anchor.classList.toggle('on', state.anchorBrows);
        anchor.textContent = state.anchorBrows ? '🔒 Brows anchored' : '⏸ Anchor brows';
      };
      anchor.addEventListener('click', () => { state.anchorBrows = !state.anchorBrows; sync(); saveCalibration(); });
      sync();
    }
    state.els.editbar.querySelector('.jf-editbar-done').addEventListener('click', () => setCalibrating(false));
  }

  function wirePointer() {
    const cv = state.els.base;
    const toLocal = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * state.dpr, y: (e.clientY - r.top) * state.dpr };
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!state.calibrating) return;
      const p = toLocal(e);
      state.stroke = { key: state.activeFeature };
      state.strokePts = [p];
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!state.stroke) return;
      const p = toLocal(e);
      const last = state.strokePts[state.strokePts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < state.dpr * 2) return;
      state.strokePts.push(p);
    });
    const endStroke = () => {
      if (!state.stroke) return;
      const key = state.stroke.key;
      state.stroke = null;
      fitFromStroke(key);
    };
    cv.addEventListener('pointerup', endStroke);
    cv.addEventListener('pointercancel', endStroke);
  }

  /* Fit the EXACT drawn shape to a feature. The lasso path is kept
     verbatim (normalized to image space, decimated for smoothness);
     an ellipse is also fitted only as a fallback / label anchor. */
  function fitFromStroke(key) {
    const pts = state.strokePts;
    state.strokePts = [];
    const tgt = state.preset[key];
    if (!tgt || pts.length < 3) return;
    const r = coverRect();
    /* 1) normalized path (image-space fractions) */
    let path = pts.map((p) => ({ x: (p.x - r.x) / r.w, y: (p.y - r.y) / r.h }));
    /* decimate to <= 60 points, keeping the shape */
    if (path.length > 60) {
      const step = path.length / 60;
      path = path.filter((_, i) => Math.floor(i / step) !== Math.floor((i + 1) / step));
    }
    tgt.path = path;
    /* 2) fitted ellipse as fallback + label anchor */
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    let sx = 0, sy = 0;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      sx += p.x; sy += p.y;
    }
    tgt.cx = (sx / pts.length - r.x) / r.w;
    tgt.cy = (sy / pts.length - r.y) / r.h;
    tgt.rx = Math.max(0.008, (maxX - minX) / 2 / r.w * 0.92);
    tgt.ry = Math.max(0.006, (maxY - minY) / 2 / r.w * 0.92);
    saveCalibration();
  }

  /* ---------- geometry ---------- */
  function sizeCanvas() {
    const c = state.els.container;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    for (const cv of [state.els.fx, state.els.base]) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    state.dpr = dpr;
    const wv = state.els.wave;
    wv.width = Math.max(1, Math.round(w * 0.42 * dpr));
    wv.height = Math.max(1, Math.round(26 * dpr));
    wv.style.width = (w * 0.42) + 'px';
    wv.style.height = 26 + 'px';
    state.cover = null;
  }

  function coverRect() {
    if (state.cover) return state.cover;
    const { img } = state;
    const vw = state.els.base.width, vh = state.els.base.height;
    if (!img || !img.naturalWidth) {
      state.cover = { x: 0, y: 0, w: vw, h: vh, scale: 1 };
      return state.cover;
    }
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(vw / iw, vh / ih);
    const dw = iw * scale, dh = ih * scale;
    state.cover = { x: (vw - dw) / 2, y: (vh - dh) / 2, w: dw, h: dh, scale };
    return state.cover;
  }

  function map(fx, fy) {
    const r = coverRect();
    return { x: r.x + fx * r.w, y: r.y + fy * r.h };
  }
  function U(f) { return f * coverRect().w; }
  function cxOf(f) { return map(f.cx, f.cy).x; }
  function cyOf(f) { return map(f.cx, f.cy).y; }

  /* ---------- path helpers ---------- */
  function pathScreen(f) {
    const r = coverRect();
    const pts = f && f.path;
    if (!pts || !pts.length) return null;
    return pts.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
  }
  function loopGeom(pts) {
    let sx = 0, sy = 0, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      sx += p.x; sy += p.y;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { cx: sx / pts.length, cy: sy / pts.length, w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY };
  }
  /* top/bottom edge per x-bucket — lets a lid sweep follow the real shape */
  function bucketEdges(pts, n) {
    const g = loopGeom(pts);
    const out = [];
    const BW = g.w / n;
    const tops = new Array(n).fill(1e9), bots = new Array(n).fill(-1e9);
    for (const p of pts) {
      let bi = Math.floor((p.x - g.minX) / BW);
      bi = Math.max(0, Math.min(n - 1, bi));
      if (p.y < tops[bi]) tops[bi] = p.y;
      if (p.y > bots[bi]) bots[bi] = p.y;
    }
    /* fill gaps between defined buckets */
    let prevT = null, prevB = null;
    for (let i = 0; i < n; i++) {
      if (tops[i] === 1e9) {
        let j = i + 1;
        while (j < n && tops[j] === 1e9) j++;
        const nextT = j < n ? tops[j] : prevT, nextB = j < n ? bots[j] : prevB;
        if (prevT !== null && nextT !== null) {
          const f = j < n ? (i - 0) / (j - 0) : 1;
          tops[i] = prevT + (nextT - prevT) * f;
          bots[i] = prevB + (nextB - prevB) * f;
        }
      } else {
        prevT = tops[i]; prevB = bots[i];
      }
    }
    for (let i = 0; i < n; i++) out.push({ x: g.minX + (i + 0.5) * BW, top: tops[i], bot: bots[i] });
    return out;
  }
  function smoothPath(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  /* ---------- color sampling ---------- */
  function sampleColors() {
    const sc = document.createElement('canvas');
    sc.width = state.img.naturalWidth; sc.height = state.img.naturalHeight;
    const sctx = sc.getContext('2d');
    sctx.drawImage(state.img, 0, 0);
    const avg = (cx, cy, w, h) => {
      const x = Math.max(0, Math.round((cx - w / 2) * sc.width));
      const y = Math.max(0, Math.round((cy - h / 2) * sc.height));
      const ww = Math.max(1, Math.round(w * sc.width));
      const hh = Math.max(1, Math.round(h * sc.height));
      const d = sctx.getImageData(x, y, ww, hh).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return { r: r / n, g: g / n, b: b / n };
    };
    const P = state.preset;
    state.colors.skin = avg(P.faceCx, P.mouth.cy - 0.06, 0.10, 0.03);
    state.colors.lip = avg(P.mouth.cx, P.mouth.cy, 0.08, 0.02);
    state.colors.dark = avg(P.eyeL.cx, P.eyeL.cy, 0.05, 0.02);
    state.colors.brow = avg(P.faceCx, P.eyeL.cy - 0.10, 0.22, 0.02);
  }
  const css = (c, a) => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;

  /* ---------- expressions ---------- */
  function applyExpression(name) {
    if (state.calibrating) return;
    state.expr = EXPRESSIONS[name] ? name : 'neutral';
  }
  function setTalking(on) {
    clearInterval(state.talkTimer);
    state.talking = !!on;
    if (on) {
      state.env = 0.9;
      state.talkBrow = 0;
      state.talkTimer = setInterval(tickTalk, 110);
    } else {
      state.env = 0;
      state.talkBrow = 0;
    }
  }
  function tickTalk() {
    state.env *= 0.78;
    if (state.env < 0.12) state.env = 0.12;
    state.talkBrow *= 0.8;
    if (Math.random() < 0.2) state.talkBrow = 1.2 + Math.random() * 1.6;
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
  function scheduleBlink() {
    clearTimeout(state.blinkTimer);
    state.blinkTimer = setTimeout(() => {
      state.blink = 1;
      setTimeout(() => { state.blink = 0; scheduleBlink(); }, 260);
    }, 1900 + Math.random() * 3600);
  }

  /* ---------- calibrate mode ---------- */
  function setCalibrating(on) {
    state.calibrating = !!on;
    state.els.editbar.style.display = on ? 'flex' : 'none';
    if (on) {
      clearInterval(state.talkTimer);
      state.talking = false; state.env = 0; state.blink = 0;
      state.expr = 'neutral';
      const active = state.preset[state.activeFeature];
      if (active && (active.rx || 0) < 0.006 && (active.ry || 0) < 0.005) state.activeFeature = 'eyeL';
      buildChips();
    } else {
      saveCalibration();
    }
  }

  /* ---------- main loop ---------- */
  function loop(t) {
    /* stop the loop when the stage is removed (persona switch) */
    if (!state.els.container.isConnected) { cancelAnimationFrame(state.raf); return; }
    const { bctx, fctx } = state.els;
    if (state.img) drawBase(bctx, t);
    drawFx(fctx, t);
    state.raf = requestAnimationFrame(loop);
  }

  function drawBase(ctx, t) {
    const dpr = state.dpr;
    const { img } = state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    const e = EXPRESSIONS[state.expr] || EXPRESSIONS.neutral;
    const r = coverRect();

    if (state.calibrating) {
      /* crisp, static render while aligning — no motion, no grading */
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      drawCalibrationOverlay(ctx);
      return;
    }

    /* head motion: breathing + speech nod + expression tilt */
    const breath = Math.sin(t / 2600) * 1.4 * dpr;
    const nod = state.talking ? Math.sin(t / 260) * state.env * 1.1 * dpr : 0;
    const ty = breath + nod;
    const rot = (e.tilt + Math.sin(t / 2200) * 0.5) * Math.PI / 180;
    const scale = 1.045 + Math.sin(t / 3600) * 0.006;

    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    ctx.save();
    ctx.translate(cx, cy + ty);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    ctx.filter = (e.filt || '') + (state.hue ? ` hue-rotate(${state.hue}deg)` : '');
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.filter = 'none';

    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = e.tint || 'transparent';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = 'source-over';

    drawBrows(ctx, t, e);
    drawNose(ctx, t, e);
    drawEyelids(ctx, t, e);
    drawMouth(ctx, t, e);

    ctx.restore();
    state.drawn = true;
  }

  /* ---------- calibration overlay: drawn paths + live drag ---------- */
  function drawCalibrationOverlay(ctx) {
    const dpr = state.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const f of FEATURES) {
      const el = state.preset[f.key];
      if (!el) continue;
      const isActive = f.key === state.activeFeature;
      drawFeatureShape(ctx, el, f.label, isActive ? '#ffd24a' : '#3df2ff', isActive);
    }
    if (state.stroke) {
      const pts = state.strokePts;
      ctx.save();
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 3 * dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(255,210,74,0.9)';
      ctx.shadowBlur = 7 * dpr;
      ctx.beginPath();
      if (pts.length > 1) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  /* Draws the exact drawn path if present, else the fitted ellipse */
  function drawFeatureShape(ctx, el, label, color, highlight) {
    const dpr = state.dpr;
    const pts = pathScreen(el);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = (highlight ? 2.6 : 1.6) * dpr;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    if (pts && pts.length >= 3) {
      smoothPath(ctx, pts);
      ctx.closePath();
    } else {
      const x = map(el.cx, el.cy).x, y = map(el.cx, el.cy).y;
      const rx = U(el.rx), ry = U(el.ry);
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.fillStyle = highlight ? 'rgba(255,210,74,0.10)' : 'rgba(61,242,255,0.06)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = `${11 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4 * dpr;
    let lx, ly;
    if (pts && pts.length) {
      const g = loopGeom(pts);
      lx = g.maxX + 6 * dpr; ly = g.minY - 6 * dpr;
    } else {
      const x = map(el.cx, el.cy).x, y = map(el.cx, el.cy).y;
      lx = x + U(el.rx) + 6 * dpr; ly = y - U(el.ry) - 6 * dpr;
    }
    ctx.fillText(label, lx, ly);
    ctx.restore();
  }

  /* ---------- brows (real drawn path, blue like her hair) ----------
     Per-emotion poses: surprised = both raised, focused = furrowed,
     playful/thoughtful = one brow raised, sad = inner ends up.
     Anchor brows freezes every pose to the drawn position. */
  function drawBrows(ctx, t, e) {
    const P = state.preset;
    const anchored = state.anchorBrows;
    const talk = state.talking ? state.talkBrow * 0.6 : 0;
    const browColor = css({ r: 22, g: 36, b: 104 }, 0.85); /* dark blue, matches her hair */
    for (const key of ['browL', 'browR']) {
      const br = P[key];
      if (!br || !br.ry) continue;
      const isLeft = key === 'browL';
      const pts = pathScreen(br);
      if (pts && pts.length >= 3) {
        drawBrowPath(ctx, e, pts, br, isLeft, anchored, talk, browColor);
        continue;
      }
      /* ellipse fallback */
      const bx = map(br.cx, br.cy).x;
      const by = map(br.cx, br.cy).y;
      const lw = U(br.rx) * 2.05;
      const lh = U(br.ry) * 1.5;
      const lift = anchored ? 0 : (isLeft ? e.browL : e.browR) + talk;
      const tilt = anchored ? 0 : e.browTilt;
      const cy = by - lift * U(0.010);
      const outerX = isLeft ? bx - lw / 2 : bx + lw / 2;
      const innerX = isLeft ? bx + lw / 2 : bx - lw / 2;
      const outerY = cy - tilt * 0.5 * U(br.ry);
      const innerY = cy + tilt * U(br.ry);
      ctx.save();
      ctx.strokeStyle = browColor;
      ctx.lineWidth = Math.max(U(br.ry) * 0.85, 1.6 * state.dpr);
      ctx.lineCap = 'round';
      ctx.shadowColor = browColor;
      ctx.shadowBlur = 3 * state.dpr;
      ctx.beginPath();
      ctx.moveTo(outerX, outerY);
      ctx.quadraticCurveTo(bx, cy - lh * 0.75, innerX, innerY);
      ctx.stroke();
      ctx.restore();
    }
  }
  function drawBrowPath(ctx, e, pts, br, isLeft, anchored, talk, browColor) {
    const g = loopGeom(pts);
    /* brow line = upper arc of the drawn loop */
    const arc = pts.filter((p) => p.y <= g.cy + g.h * 0.08).sort((a, b) => a.x - b.x);
    if (arc.length < 3) return;
    const lift = anchored ? 0 : (isLeft ? e.browL : e.browR) + talk;
    const tilt = anchored ? 0 : e.browTilt;
    const liftPx = lift * U(0.010);
    const tiltPx = g.w > 1 ? (tilt * U(br.ry)) / (g.w / 2) : 0;
    const posed = arc.map((p) => {
      const innerDx = isLeft ? (p.x - g.cx) : (g.cx - p.x);
      return { x: p.x, y: p.y - liftPx + tiltPx * innerDx };
    });
    ctx.save();
    ctx.strokeStyle = browColor;
    ctx.lineWidth = Math.max(U(br.ry) * 1.05, 1.6 * state.dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = browColor;
    ctx.shadowBlur = 3 * state.dpr;
    ctx.beginPath();
    smoothPath(ctx, posed);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- nose (subtle shading inside the drawn nose loop) ---------- */
  function drawNose(ctx, t, e) {
    const skin = state.colors.skin;
    if (!skin) return;
    const n = state.preset.nose;
    if (!n || !n.ry) return;
    const pts = pathScreen(n);
    const breath = Math.sin(t / 2600) * 0.06 + (state.talking ? state.env * 0.15 : 0);
    let g;
    if (pts && pts.length >= 3) {
      g = loopGeom(pts);
    } else {
      const x = map(n.cx, n.cy).x, y = map(n.cx, n.cy).y;
      g = { cx: x, cy: y, w: U(n.rx) * 2, h: U(n.ry) * 2 };
    }
    const cx = g.cx, cy = g.cy, nw = g.w, nh = g.h;
    ctx.save();
    /* side shading */
    ctx.fillStyle = css(skin, 0.28);
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 4 * state.dpr;
    ctx.beginPath();
    ctx.ellipse(cx - nw * 0.30, cy, nw * 0.11, nh * (0.30 + breath * 0.4), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + nw * 0.30, cy, nw * 0.11, nh * (0.30 + breath * 0.4), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    /* bridge highlight */
    ctx.save();
    ctx.fillStyle = css(skin, 0.55);
    ctx.shadowColor = 'rgba(255,255,255,0.4)';
    ctx.shadowBlur = 3 * state.dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy - nh * 0.16, nw * 0.13, nh * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    /* tip */
    ctx.save();
    ctx.fillStyle = css(skin, 0.5);
    ctx.shadowColor = 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = 4 * state.dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy + nh * 0.30, nw * 0.15, nh * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---------- eyelids (sweep down following the drawn eye shape) ---------- */
  function drawEyelids(ctx, t, e) {
    const skin = state.colors.skin;
    if (!skin) return;
    const lid = Math.max(e.lid, 0) + state.blink;
    if (lid <= 0.01) return;
    const skinColor = css(skin, 0.94);
    for (const eye of [state.preset.eyeL, state.preset.eyeR]) {
      const pts = pathScreen(eye);
      if (pts && pts.length >= 3) {
        drawEyelidPath(ctx, lid, pts, skinColor);
        continue;
      }
      /* ellipse fallback */
      const x = map(eye.cx, eye.cy).x, y = map(eye.cx, eye.cy).y;
      const rx = U(eye.rx), ry = U(eye.ry);
      const lw = rx * 2.2;
      const top = y - ry;
      const cover = ry * 2 * Math.min(1, lid);
      ctx.save();
      ctx.fillStyle = skinColor;
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 3 * state.dpr;
      ctx.beginPath();
      ctx.moveTo(x - lw / 2, top - U(0.002));
      ctx.lineTo(x + lw / 2, top - U(0.002));
      ctx.lineTo(x + lw / 2, top + cover * 0.8);
      ctx.quadraticCurveTo(x, top + cover * 1.12, x - lw / 2, top + cover * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  function drawEyelidPath(ctx, lid, pts, skinColor) {
    const edges = bucketEdges(pts, 34);
    if (!edges.length) return;
    ctx.save();
    ctx.fillStyle = skinColor;
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 2.5 * state.dpr;
    ctx.beginPath();
    for (let i = 0; i < edges.length; i++) {
      const p = edges[i];
      if (i === 0) ctx.moveTo(p.x, p.top);
      else ctx.lineTo(p.x, p.top);
    }
    for (let i = edges.length - 1; i >= 0; i--) {
      const p = edges[i];
      ctx.lineTo(p.x, p.top + lid * (p.bot - p.top) * 1.02);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    /* lid crease */
    if (lid > 0.08) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = Math.max(1, state.dpr);
      ctx.beginPath();
      for (let i = 0; i < edges.length; i++) {
        const p = edges[i];
        const y = p.top + lid * (p.bot - p.top) * 1.02;
        if (i === 0) ctx.moveTo(p.x, y);
        else ctx.lineTo(p.x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------- mouth (feathered lips + opening, from the drawn lip shape) ---------- */
  function drawMouth(ctx, t, e) {
    const skin = state.colors.skin;
    if (!skin) return;
    const m = state.preset.mouth;
    const pts = pathScreen(m);
    if (pts && pts.length >= 4) {
      drawMouthPath(ctx, e, pts);
      return;
    }
    /* ellipse fallback */
    const lip = state.colors.lip;
    const amp = Math.min(1, state.talking ? state.env : e.open);
    const x = map(m.cx, m.cy).x, y = map(m.cx, m.cy).y;
    const W = U(m.rx) * (1 + amp * 0.18);
    const smile = e.smile;
    const lipUp = U(m.ry) * 0.8, lipDown = U(m.ry) * 1.0;
    const openH = U(m.ry) * (0.12 + amp * 2.6);
    const cornerDrop = smile * U(m.ry) * 0.65;
    const lipColor = lip ? css(lip, 0.95) : 'rgba(196,110,122,0.95)';
    const lipDark = lip ? css(lip, 0.9) : 'rgba(156,80,98,0.9)';
    const mouthIn = 'rgba(88,28,36,0.96)';
    const bl = 2.5 * state.dpr;
    ctx.save();
    ctx.fillStyle = mouthIn;
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = bl;
    ctx.beginPath();
    ctx.moveTo(x - W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x, y - openH * 0.35, x + W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x, y + openH * 1.15 + cornerDrop * 0.4, x - W, y + cornerDrop * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = lipColor;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = bl;
    ctx.beginPath();
    ctx.moveTo(x - W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x - W * 0.28, y - lipUp - openH * 0.32, x, y - lipUp * 0.82 - openH * 0.22);
    ctx.quadraticCurveTo(x + W * 0.28, y - lipUp - openH * 0.32, x + W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x, y + openH * 0.05, x - W, y + cornerDrop * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = lipDark;
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = bl;
    ctx.beginPath();
    ctx.moveTo(x - W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x, y + openH * 0.05, x + W, y + cornerDrop * 0.4);
    ctx.quadraticCurveTo(x, y + lipDown + openH * 1.1 + cornerDrop * 0.5, x - W, y + cornerDrop * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (amp < 0.5) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = U(m.ry) * 0.22;
      ctx.beginPath();
      ctx.moveTo(x - W * 0.6, y + cornerDrop * 0.4 - U(m.ry) * 0.34);
      ctx.quadraticCurveTo(x, y - U(m.ry) * 0.6, x + W * 0.6, y + cornerDrop * 0.4 - U(m.ry) * 0.34);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* Shape-accurate mouth: the drawn loop IS her lips. As she talks,
     the upper half rises and the lower half drops, so the opening
     follows the exact silhouette she was drawn with. */
  function drawMouthPath(ctx, e, pts) {
    const lip = state.colors.lip;
    const skin = state.colors.skin;
    const g = loopGeom(pts);
    const upper = pts.filter((p) => p.y <= g.cy).sort((a, b) => a.x - b.x);
    const lower = pts.filter((p) => p.y > g.cy).sort((a, b) => b.x - a.x);
    const amp = Math.min(1, state.talking ? state.env : e.open);
    const smile = e.smile;
    const lipColor = lip ? css(lip, 0.95) : 'rgba(196,110,122,0.95)';
    const lipDark = lip ? css(lip, 0.9) : 'rgba(156,80,98,0.9)';
    const mouthIn = 'rgba(88,28,36,0.96)';
    const bl = 2.5 * state.dpr;
    const openH = g.h * (0.12 + amp * 2.4);          /* interior height */
    const upFac = 1 - 0.16 * amp;                    /* upper lip lifts a touch */
    const dnFac = 1 + 0.9 * amp;                     /* lower lip drops */
    const up = (p) => ({ x: p.x, y: g.cy - (g.cy - p.y) * upFac });
    const dn = (p) => ({ x: p.x, y: g.cy + (p.y - g.cy) * dnFac });
    const UL = upper.map(up);
    const LL = lower.map(dn);
    const cornerDrop = smile * g.h * 0.12;
    const yTop = g.cy - openH * 0.28 + cornerDrop;   /* interior ceiling */
    const yBot = g.cy + openH * 0.55 + cornerDrop;   /* interior floor */
    const midX = g.cx;

    ctx.save();
    ctx.translate(midX, g.cy);
    ctx.rotate(smile * 0.02);
    ctx.translate(-midX, -g.cy);

    /* 1) dark interior */
    ctx.save();
    ctx.fillStyle = mouthIn;
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = bl;
    ctx.beginPath();
    ctx.moveTo(UL.length ? UL[0].x : g.minX, yTop);
    ctx.quadraticCurveTo(midX, yTop - openH * 0.18, UL.length ? UL[UL.length - 1].x : g.maxX, yTop);
    ctx.lineTo(LL.length ? LL[0].x : g.maxX, yBot);
    ctx.quadraticCurveTo(midX, yBot + openH * 0.16, LL.length ? LL[LL.length - 1].x : g.minX, yBot);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    /* 2) upper lip (drawn upper arc, closed at the interior ceiling) */
    if (UL.length >= 2) {
      ctx.save();
      ctx.fillStyle = lipColor;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = bl;
      ctx.beginPath();
      smoothPath(ctx, UL);
      ctx.quadraticCurveTo(midX, yTop + openH * 0.14, UL[0].x, yTop);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* 3) lower lip (drawn lower arc, closed at the interior floor) */
    if (LL.length >= 2) {
      ctx.save();
      ctx.fillStyle = lipDark;
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = bl;
      ctx.beginPath();
      smoothPath(ctx, LL);
      ctx.quadraticCurveTo(midX, yBot - openH * 0.10, LL[LL.length - 1].x, yBot);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* 4) sheen across the upper lip when mostly closed */
    if (amp < 0.5 && UL.length >= 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.26)';
      ctx.lineWidth = Math.max(g.h * 0.06, 1);
      ctx.lineCap = 'round';
      ctx.beginPath();
      const a = UL[0], b = UL[UL.length - 1];
      ctx.moveTo(a.x + (b.x - a.x) * 0.2, a.y);
      ctx.quadraticCurveTo(midX, g.cy - g.h * 0.55, b.x - (b.x - a.x) * 0.2, b.y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    void skin;
  }

  /* ---------- hologram FX ---------- */
  function spawnParticles() {
    state.particles = [];
    for (let i = 0; i < 70; i++) {
      state.particles.push({
        x: Math.random(), y: Math.random(),
        r: 0.6 + Math.random() * 1.8,
        vy: 0.05 + Math.random() * 0.3,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.4 + Math.random() * 0.8,
        alpha: 0.08 + Math.random() * 0.3,
        pink: Math.random() < 0.75,
      });
    }
  }

  function drawFx(ctx, t) {
    const dpr = state.dpr;
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.img || state.calibrating) return;

    const speaking = state.talking || state.listening > 0.05;
    const P = state.preset;
    const fc = map(P.faceCx, P.faceCy);
    const cx = fc.x, cy = fc.y;
    const rx = Math.min(w, h) * 0.3;
    const ry = rx * 1.08;
    const pulse = 1 + (speaking ? 0.016 : 0) + Math.sin(t / 900) * 0.006;

    ctx.save();
    ctx.shadowColor = 'rgba(255, 150, 200, 0.5)';
    ctx.shadowBlur = 24 * dpr;
    ctx.strokeStyle = speaking ? 'rgba(255, 195, 220, 0.6)' : 'rgba(255, 185, 212, 0.42)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * pulse, ry * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 220, 240, 0.1)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.15 * pulse, ry * 1.15 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    const rot = t / 4200;
    ctx.strokeStyle = 'rgba(255, 195, 220, 0.45)';
    ctx.lineWidth = 1.1 * dpr;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2 + rot;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rx * pulse * 0.985, Math.sin(a) * rx * pulse * 0.985 * (ry / rx));
      ctx.lineTo(Math.cos(a) * rx * pulse * 1.028, Math.sin(a) * rx * pulse * 1.028 * (ry / rx));
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    for (const p of state.particles) {
      p.y -= p.vy * (1 / 60) * 2.2;
      p.sway += p.swaySpeed * (1 / 60) * 2.2;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      const px = (p.x + Math.sin(p.sway) * 0.015) * w;
      const py = p.y * h;
      const flicker = 0.6 + 0.4 * Math.sin(t / 300 + p.sway * 3);
      ctx.beginPath();
      ctx.arc(px, py, p.r * dpr, 0, Math.PI * 2);
      ctx.fillStyle = p.pink
        ? `rgba(255, 205, 225, ${p.alpha * flicker})`
        : `rgba(255, 240, 248, ${p.alpha * 0.7 * flicker})`;
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.03)';
    for (let y = 0; y < h; y += 3 * dpr) ctx.fillRect(0, y, w, 1 * dpr);
    const bandY = ((t / 40) % (h + 220)) - 110;
    const grad = ctx.createLinearGradient(0, bandY - 60, 0, bandY + 60);
    grad.addColorStop(0, 'rgba(255,200,225,0)');
    grad.addColorStop(0.5, 'rgba(255,200,225,0.045)');
    grad.addColorStop(1, 'rgba(255,200,225,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandY - 60, w, 120);

    if (Math.random() < 0.0014) {
      const gy = Math.random() * h;
      const gh = 20 * dpr + Math.random() * 40 * dpr;
      try {
        const slice = ctx.getImageData(0, gy, w, gh);
        ctx.putImageData(slice, (Math.random() - 0.5) * 40 * dpr, gy);
      } catch {}
    }

    for (let i = 0; i < 130; i++) {
      const gx = Math.random() * w, gy = Math.random() * h;
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
      ctx.fillRect(gx, gy, 1 * dpr, 1 * dpr);
    }

    if (state.listening > 0.02) {
      ctx.save();
      ctx.strokeStyle = `rgba(140,255,180,${0.25 + state.listening * 0.35})`;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = 'rgba(140,255,180,0.5)';
      ctx.shadowBlur = 18 * dpr;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * (1.05 + state.listening * 0.08), ry * (1.05 + state.listening * 0.08), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawWave(t);
  }

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
      wctx.fillStyle = `rgba(255, 195, 222, ${0.3 + wave * 0.45})`;
      wctx.fillRect(i * bw + bw * 0.18, (wh - bh) / 2, bw * 0.6, bh);
    }
  }

  const api = {
    init, setExpression: (n) => applyExpression(n), setTalking,
    speechImpulse, setListening, setHue, expressions: ORDER,
    calibrate: setCalibrating, saveCalibration,
  };

  global.JoiLiving = api;
})(window);
