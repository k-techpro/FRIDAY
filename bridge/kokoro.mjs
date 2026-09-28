/**
 * Supervises the local Kokoro TTS server as a child process.
 *
 * The browser talks to the Kokoro server directly over HTTP (src/lib/kokoro.ts
 * POSTs straight to KOKORO_URL) — this module's only job is making sure that
 * server exists before anyone needs it: start it once, skip starting a second
 * one if something is already answering on the configured port, and tear it
 * down when the bridge exits. The model itself loads once, inside app.py, and
 * stays resident for the life of the process — that's what makes generation
 * fast; nothing here reloads it per request.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..', 'kokoro-server')

export const KOKORO_HOST = process.env.KOKORO_HOST ?? '127.0.0.1'
export const KOKORO_PORT = process.env.KOKORO_PORT ?? '8880'
export const KOKORO_URL = `http://${KOKORO_HOST}:${KOKORO_PORT}`

const pythonExe =
  process.platform === 'win32'
    ? join(SERVER_DIR, '.venv', 'Scripts', 'python.exe')
    : join(SERVER_DIR, '.venv', 'bin', 'python')

let child = null

async function healthy(timeoutMs) {
  try {
    const res = await fetch(`${KOKORO_URL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Start the Kokoro server if nothing is already serving on its port, and wait
 * for it to report healthy. Never throws — a missing venv or a slow model load
 * just means voice falls back to the browser's own speech, not a dead bridge.
 */
export async function ensureKokoroServer({ waitMs = 120_000 } = {}) {
  if (!existsSync(pythonExe)) {
    console.warn(
      `[jarvis] kokoro-server venv not found at ${pythonExe} — voice will fall back to ` +
        'the browser. See kokoro-server/README.md to set it up.',
    )
    return false
  }

  if (await healthy(1500)) {
    console.log(`[jarvis] kokoro server already answering at ${KOKORO_URL} — reusing it`)
    return true
  }

  console.log(`[jarvis] starting local kokoro TTS server (this can take a while on first CUDA warm-up)...`)
  child = spawn(pythonExe, ['app.py'], {
    cwd: SERVER_DIR,
    env: { ...process.env, KOKORO_HOST, KOKORO_PORT },
    stdio: 'pipe',
  })
  child.stdout.on('data', (d) => process.stdout.write(`\x1b[33mkokoro\x1b[0m ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`\x1b[33mkokoro\x1b[0m ${d}`))
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.warn(`[jarvis] kokoro server exited unexpectedly (${code})`)
    }
    child = null
  })

  const started = Date.now()
  while (Date.now() - started < waitMs) {
    if (await healthy(1000)) {
      console.log(
        `[jarvis] kokoro server ready at ${KOKORO_URL} (${Math.round((Date.now() - started) / 1000)}s)`,
      )
      return true
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.warn(
    `[jarvis] kokoro server did not become healthy within ${waitMs / 1000}s — voice falls back to the browser`,
  )
  return false
}

export function stopKokoroServer() {
  if (!child) return
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  child = null
}
