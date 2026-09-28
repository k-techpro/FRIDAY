"""
Local Kokoro TTS server for FRIDAY.

Why this exists: kokoro-js in the browser (src/lib/kokoro.ts) runs the model
via WebGPU/ONNX and measured at roughly 2.2x slower than real time on this
machine — unusable for a spoken conversation. This process runs the same
Kokoro-82M model through PyTorch instead, on the RTX 3050 via CUDA when
available, and loads it exactly once at startup so every request afterwards
reuses the resident model. That's the whole point: no per-request load.

Exposes:
  GET  /health           -- readiness probe (also reports which device the
                             model is running on)
  POST /v1/audio/speech   -- { input, voice?, speed? } -> audio/wav bytes

Started automatically by the bridge (see bridge/kokoro.mjs); run directly with:
  .venv\\Scripts\\python.exe app.py
"""

import io
import os

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

VOICE = os.environ.get("KOKORO_VOICE", "bm_george")
LANG = os.environ.get("KOKORO_LANG", "b")  # 'b' = British English
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
PORT = int(os.environ.get("KOKORO_PORT", "8880"))
HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
SAMPLE_RATE = 24000

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
GPU_NAME = torch.cuda.get_device_name(0) if DEVICE == "cuda" else None
print(f"[kokoro-server] torch device: {DEVICE}" + (f" ({GPU_NAME})" if GPU_NAME else ""))

from kokoro import KPipeline  # noqa: E402  (import after device/env setup, matches upstream examples)

print(f"[kokoro-server] loading Kokoro pipeline (lang_code={LANG!r}, voice={VOICE!r})...")
try:
    pipeline = KPipeline(lang_code=LANG, device=DEVICE)
except TypeError:
    # Older kokoro releases don't take a `device` kwarg — they place the model
    # on CUDA automatically when it's available, so this is a safe fallback.
    pipeline = KPipeline(lang_code=LANG)
print("[kokoro-server] model resident — ready.")

app = FastAPI()

# Matches the dev port ranges the Node bridge trusts (see isDevPort in
# bridge/server.mjs): Vite's 5173-5199 and `vite preview`'s 4173-4199.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):(51[7-9]\d|41[7-9]\d)$",
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["content-type"],
)


class SpeechRequest(BaseModel):
    input: str
    voice: str | None = None
    speed: float | None = None


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "gpu": GPU_NAME, "voice": VOICE, "lang": LANG}


@app.post("/v1/audio/speech")
def synthesize(req: SpeechRequest):
    text = (req.input or "").strip()
    if not text:
        raise HTTPException(400, "no input text")
    voice = req.voice or VOICE
    speed = req.speed or SPEED

    try:
        chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed)]
    except Exception as err:  # a bad voice id or a phonemizer failure, surfaced plainly
        raise HTTPException(500, f"generation failed: {err}") from err
    if not chunks:
        raise HTTPException(500, "no audio generated")
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    # In-memory WAV — nothing written to disk, so nothing to clean up.
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
