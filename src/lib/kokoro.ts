/**
 * Neural speech via a local Kokoro server.
 *
 * This used to run entirely in the browser via kokoro-js (WebGPU/ONNX). That
 * sounded good but measured at roughly 2.2x slower than real time on this
 * machine — "Yes, sir?" took 3.3 seconds — which is not a conversation. This
 * module instead talks over HTTP to a small Python process
 * (kokoro-server/app.py) that runs the same Kokoro-82M model through PyTorch,
 * on the GPU when one is available, with the model loaded once at server
 * startup and kept resident. The bridge brings that process up automatically
 * (see bridge/kokoro.mjs); this module's job is only to find out whether it's
 * up yet and to call it.
 *
 * Same fallback contract as before: anything that goes wrong here — the
 * server never starts, a generation fails — drops to the system voice
 * audibly, rather than going silent.
 */

import { KOKORO_URL, KOKORO_VOICE, KOKORO_SPEED } from '../config'

let ready = false
let failed = false
let checking: Promise<boolean> | null = null

/** 0 or 1 — there's no partial-download progress with a server, only up or
 *  not yet, but App.tsx's boot readout polls this the same way it did for the
 *  old download-progress number. */
export const loadProgress = () => (ready ? 1 : 0)
export const isReady = () => ready
export const isUnavailable = () => failed

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/** British male voices the server is expected to carry. */
export const VOICES = ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const

/**
 * A voice id the server doesn't carry fails every request for the life of the
 * page, and a typo in an env var is the likeliest way to get there. Check it
 * once at module load and fall back audibly in the console instead.
 */
function resolveVoice(): string {
  if ((VOICES as readonly string[]).includes(KOKORO_VOICE)) return KOKORO_VOICE
  console.warn(
    `[jarvis] VITE_KOKORO_VOICE="${KOKORO_VOICE}" is not one of ${VOICES.join(', ')} — using ${VOICES[0]}.`,
  )
  return VOICES[0]
}

const voice = resolveVoice()

/**
 * Generation failures latch after this many in a row. One is worth retrying —
 * a request can drop — but a run of them means the server isn't going to work
 * this session, and it's better to drop to the system voice for good than to
 * alternate between the two mid-conversation.
 */
const MAX_FAILURES = 3
let failures = 0

/** How long to keep polling /health before giving up on this session. The
 *  bridge usually already has the server up by the time the browser boots,
 *  but a cold CUDA warm-up can take the better part of a minute. */
const HEALTH_TIMEOUT_MS = 100_000

/** Poll the server's /health until it answers or the timeout above passes. */
export async function load(): Promise<boolean> {
  if (ready) return true
  if (failed) return false
  if (checking) return checking

  checking = (async () => {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    for (;;) {
      try {
        const res = await fetch(`${KOKORO_URL}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          ready = true
          return true
        }
      } catch {
        /* server not up yet — keep polling */
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.warn(
      `[jarvis] kokoro server never answered at ${KOKORO_URL} — using the system voice. ` +
        'Is the bridge running? See kokoro-server/README.md.',
    )
    lastError = 'server unreachable'
    failed = true
    return false
  })()

  try {
    return await checking
  } finally {
    checking = null
  }
}

/** Synthesise one sentence. Returns null if the server isn't usable. */
export async function speak(text: string): Promise<string | null> {
  const up = await load()
  if (!up) return null
  try {
    const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text, voice, speed: KOKORO_SPEED }),
    })
    if (!res.ok) throw new Error(`kokoro server responded ${res.status}`)
    const blob = await res.blob()
    failures = 0
    return URL.createObjectURL(blob)
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[jarvis] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= MAX_FAILURES) {
      failed = true
      console.warn(
        `[jarvis] kokoro failed ${failures} times running — the system voice from here on.`,
      )
    }
    return null
  }
}

/** Voice ids this build is expected to carry. Static, since the server
 *  doesn't expose a voice-listing endpoint. */
export async function availableVoices(): Promise<string[]> {
  return [...VOICES]
}
