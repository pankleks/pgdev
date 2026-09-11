import type { PoolClient } from 'pg'

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
  timer: NodeJS.Timeout | null
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
): void {
  const prev = sessions.get(key)
  if (prev?.timer) clearTimeout(prev.timer)
  const s: Session = { connId, client, cursor, timer: null }
  sessions.set(key, s)
  // Only arm the reaper while a transaction may be left open.
  if (cursor) armReaper(key, s)
}

/** Idempotent: safe to call twice or on an already-released client. */
export async function teardownSession(
  key: string,
  mode: 'commit' | 'rollback',
): Promise<void> {
  const s = sessions.get(key)
  if (!s) return
  sessions.delete(key)
  if (s.timer) clearTimeout(s.timer)
  try {
    await s.client.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK')
  } catch {
    // Transaction may already be gone (cancel, error, reaper race).
  }
  try {
    s.client.release()
  } catch {
    // Already released.
  }
}

export async function closeSessionsForConnection(connId: string): Promise<void> {
  const keys = [...sessions.keys()].filter((k) => sessions.get(k)?.connId === connId)
  await Promise.all(keys.map((k) => teardownSession(k, 'rollback')))
}
