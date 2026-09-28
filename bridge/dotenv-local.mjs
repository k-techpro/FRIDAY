/**
 * Minimal .env.local loader for the Node-side processes (bridge, kokoro.mjs).
 *
 * Vite loads .env.local automatically for the frontend; nothing does that for
 * plain Node, so the bridge's own KOKORO_* and TTS_PROVIDER settings would
 * otherwise be readable only from real shell environment variables. Real env
 * vars still win — this only fills in what isn't already set — so
 * `npm run bridge:writes` and friends keep working unchanged.
 *
 * Imported for its side effect only, and first, so anything imported after it
 * sees the filled-in process.env at module-load time.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  const text = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const [, key, rawVal] = m
    if (process.env[key] !== undefined) continue
    const val = /^(['"]).*\1$/.test(rawVal) ? rawVal.slice(1, -1) : rawVal
    process.env[key] = val
  }
} catch {
  /* no .env.local — everything has a default */
}
