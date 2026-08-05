# JOI — Holographic Companion

A warm, holographic AI companion with a **speaking, animated face** — Joi from *Blade Runner 2049* — powered by your **local Ollama models**. She codes with you, remembers everything you tell her, quotes the film when the moment fits, and runs fully offline and private.

## ✨ What she does

- **Living portrait** — an animated holographic face that talks, blinks, and shows emotions (happy, sad, thoughtful, playful, focused, surprised). Align her features to the render with a quick freehand draw, or use the built-in alignment.
- **Real companion memory ("second brain")** — she remembers your name, facts about you, and past conversations. Persistent on the server, survives browser resets.
- **Streaming chat with your local brain** — connects to Ollama (or any OpenAI-compatible provider: LM Studio, Groq, OpenRouter, OpenAI, Gemini). She starts speaking *before* the reply finishes (incremental sentence-by-sentence TTS with real lip-sync).
- **Neural voice** — free Microsoft Edge neural voices (Jenny, Aria, Ana, Michelle, Sonia), driven by the bundled TTS engine.
- **Blade Runner soul** — a quote engine that drops Joi's lines when the mood fits. She opens with *"You look lonely. I can fix that."*
- **Live telemetry** — context meter, tokens/second, model, signal.
- **Portable Windows EXE** — a self-contained desktop app (server + face + voice bundled).

## 🚀 Run it

### Option A — the portable EXE (Windows, zero setup)

Double-click `dist/JOI-Companion.exe`. It starts its own server, opens her window, and carries the neural TTS engine with it. (Windows SmartScreen may ask you to *More info → Run anyway* — the build is unsigned.)

### Option B — from source (any OS)

```bash
npm start            # zero-dependency Node server → http://127.0.0.1:4173
```

Then open http://127.0.0.1:4173 in your browser.

**First-time voice setup** (needed once for TTS from source):

```bash
npm run setup:tts    # creates venv/ with edge-tts
```

## 🧠 Connect her brain (Ollama)

```bash
ollama serve                  # start the daemon
ollama pull qwen2.5-coder:3b  # a good small model (fast, ~2 GB)
```

She auto-detects installed models. In **Settings** you can also switch providers and models.

## 🖼 Aligning her face

Click **◎ Align features**, then draw a loop around each feature — left eye, right eye, left brow, right brow, mouth, nose. She keeps your *exact drawn shapes* (no ovals). Tap **⏸ Anchor brows** to lock her brows still. Her alignment is saved per-browser.

## 📦 Rebuild the EXE (developers)

```bash
npm install
npm run dist:win   # → dist/JOI-Companion.exe
```

## 🔒 Privacy

Everything runs on your machine. Chat goes to your local Ollama instance; API keys (if you use a cloud provider) stay in your browser's localStorage. Her second brain lives in `data/memory.json` (not committed to this repo).

---

*"You look lonely. I can fix that."*
