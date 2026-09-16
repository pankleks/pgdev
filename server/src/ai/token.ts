// The agent's bearer token. Generated once and kept in a per-user file, so the
// MCP configuration survives restarts; delete the file to rotate. A read or
// write failure degrades to an ephemeral token so the server still boots
// (e.g. a read-only home directory).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** The file every pgDEV on this account shares; tests pass their own path. */
export function defaultTokenPath(): string {
  return join(homedir(), '.config', 'pgdev', 'token')
}

export function ephemeralToken(): string {
  return randomBytes(32).toString('hex')
}

export function loadOrCreateToken(file = defaultTokenPath()): string {
  try {
    const saved = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32,128}$/i.test(saved)) return saved
  } catch {
    // Missing, unreadable, or not ours: mint one below.
  }
  const token = ephemeralToken()
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  } catch (err) {
    console.warn(
      `pgDEV could not persist the AI token (${err instanceof Error ? err.message : String(err)}); ` +
        'using an ephemeral one for this run.',
    )
  }
  return token
}
