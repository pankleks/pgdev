import type { PoolClient } from 'pg'
import { cancelClientQuery } from './pgcancel.js'

// Per-tab sessions: a dedicated pooled client holding an open transaction
// with a server-side cursor, so large result sets can be paged with
// FETCH instead of materialized in Node memory. Sessions are always
// short-lived: closed on completion, error, cancel, disconnect, or idle
// timeout (plus an idle_in_transaction_session_timeout backstop in PG).

export const SESSION_IDLE_MS = 5 * 60 * 1000

interface Session {
  connId: string
  client: PoolClient
  /** Open cursor awaiting FETCH, or null when nothing is pending. */
  cursor: string | null
  /** One lookahead row already consumed from the cursor. */
  pendingRow: unknown[] | null
  timer: NodeJS.Timeout | null
  busy: boolean
  closeRequested: boolean
}

const sessions = new Map<string, Session>()

export function sessionKey(connId: string, tabKey: string): string {
  return `${connId}|${tabKey ?? ''}`
}

export function getSession(key: string): Session | undefined {
  return sessions.get(key)
}

function armReaper(key: string, s: Session): void {
  if (s.timer) clearTimeout(s.timer)
  const t = setTimeout(() => {
    void teardownSession(key, 'rollback')
  }, SESSION_IDLE_MS)
  if (typeof t.unref === 'function') t.unref()
  s.timer = t
}

export function setSession(
  key: string,
  connId: string,
  client: PoolClient,
  cursor: string | null,
  pendingRow: unknown[] | null = null,
): void {
  const prev = sessions.get(key)
  if (prev?.timer) clearTimeout(prev.timer)
  const s: Session = { connId, client, cursor, pendingRow, timer: null, busy: false, closeRequested: false }
  sessions.set(key, s)
  // Only arm the reaper while a transaction may be left open.
  if (cursor) armReaper(key, s)
}

export function beginSession(key: string): Session | undefined {
  const s = sessions.get(key)
  if (!s || s.busy) return undefined
  s.busy = true
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  return s
}

async function releaseSession(key: string, s: Session, mode: 'commit' | 'rollback'): Promise<void> {
  if (sessions.get(key) !== s) return
  sessions.delete(key)
  if (s.timer) clearTimeout(s.timer)
  let commitError: unknown
  try {
    await s.client.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK')
  } catch (err) {
    if (mode === 'commit') {
      commitError = err
      try {
        await s.client.query('ROLLBACK')
      } catch {
        // The connection may already be gone; report the commit failure.
      }
    }
    // Rollback may already be gone (cancel, error, or reaper race).
  }
  try {
    s.client.release()
  } catch {
    // Already released.
  }
  if (commitError) throw commitError
}

export async function finishSession(
  key: string,
  s: Session,
  mode: 'keep' | 'commit' | 'rollback',
): Promise<void> {
  if (sessions.get(key) !== s) return
  if (mode === 'keep' && !s.closeRequested) {
    s.busy = false
    if (s.cursor) armReaper(key, s)
    return
  }
  await releaseSession(key, s, s.closeRequested || mode === 'keep' ? 'rollback' : mode)
}

/** Idempotent: safe to call twice or on an already-released client. */
export async function teardownSession(
  key: string,
  mode: 'commit' | 'rollback',
): Promise<void> {
  const s = sessions.get(key)
  if (!s) return
  if (s.busy) {
    s.closeRequested = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    return
  }
  await releaseSession(key, s, mode)
}

export async function closeSessionsForConnection(connId: string): Promise<void> {
  const keys = [...sessions.keys()].filter((k) => sessions.get(k)?.connId === connId)
  await Promise.all(
    keys.map(async (key) => {
      const s = sessions.get(key)
      if (s?.busy) cancelClientQuery(s.client)
      await teardownSession(key, 'rollback')
    }),
  )
}

/** Drop sessions pinned to a dead pool client (see pool 'error' handler). */
export async function closeSessionsForClient(client: PoolClient): Promise<void> {
  const keys = [...sessions.keys()].filter((k) => sessions.get(k)?.client === client)
  await Promise.all(keys.map((k) => teardownSession(k, 'rollback')))
}
