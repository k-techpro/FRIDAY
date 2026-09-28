# Kokoro TTS server

A small local speech server for FRIDAY/JARVIS. It runs the
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model through PyTorch —
on your GPU when one is available — loads it exactly once at startup, and
keeps it resident so every request afterwards reuses the loaded model instead
of paying a load cost per sentence.

You should not normally need to touch this directory. The bridge
(`bridge/kokoro.mjs`) starts this server automatically whenever you run
`npm start` or `npm run bridge`, waits for it to report healthy, and stops it
when the bridge exits. This README is for setting it up the first time, and
for running/debugging it by hand.

## One-time setup

Requires Python 3.11 and [eSpeak NG](https://github.com/espeak-ng/espeak-ng)
(Kokoro's phonemizer backend for languages other than a couple of built-ins).

```bash
py -3.11 -m venv .venv
.venv\Scripts\pip install --upgrade pip
.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\pip install -r requirements.txt
```

The `--index-url` line installs the CUDA build of PyTorch. If you don't have
an NVIDIA GPU, install plain `torch` instead (drop the `--index-url`) — the
server falls back to CPU automatically either way (`torch.cuda.is_available()`
decides at startup; see the `[kokoro-server] torch device: ...` line it prints).

eSpeak NG: `winget install eSpeak-NG.eSpeak-NG`. Without it, British-English
phonemization (`lang_code=b`, what the bm_* voices need) will fail.

## Running it directly

Normally the bridge does this for you. To run it standalone, e.g. for
debugging:

```bash
.venv\Scripts\python app.py
```

It prints which device it loaded onto, then `model resident — ready.` once
the model has finished loading. That message is the whole point of the
"loaded once, kept resident" design — every request after it reuses the same
in-memory model.

## API

**`GET /health`**
```json
{ "ok": true, "device": "cuda", "gpu": "NVIDIA GeForce RTX 3050 Laptop GPU", "voice": "bm_george", "lang": "b" }
```

**`POST /v1/audio/speech`**
```json
{ "input": "FRIDAY systems are online.", "voice": "bm_george", "speed": 1.0 }
```
Returns `audio/wav` bytes. `voice` and `speed` are optional — they fall back
to `KOKORO_VOICE`/`KOKORO_SPEED` (see `.env.example` at the project root).
Nothing is written to disk; audio is generated into an in-memory buffer and
returned directly.

## Configuration

All read from the environment (including `.env.local` at the project root —
see `bridge/dotenv-local.mjs`, which loads it for the Node side too):

| Variable | Default | Effect |
|---|---|---|
| `KOKORO_HOST` | `127.0.0.1` | Bind address |
| `KOKORO_PORT` | `8880` | Bind port |
| `KOKORO_VOICE` | `bm_george` | Default voice when a request doesn't specify one |
| `KOKORO_SPEED` | `1.0` | Default speed |
| `KOKORO_LANG` | `b` | Kokoro's phonemizer language — `b` for the British voices |

## Voices

British male, in the order they suit a calm, sophisticated AI-assistant
character (see the comparison notes in the project's TTS integration report):
`bm_george`, `bm_fable`, `bm_lewis`, `bm_daniel`.
