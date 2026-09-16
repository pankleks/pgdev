import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { cancelClientQuery } from './pgcancel.js'
import type { TransactionState } from './schema-types.js'

// Per-tab sessions: a dedicated pooled client holding an open transaction
// with a server-side cursor, so large result sets can be paged with
// FETCH instead of materialized in Node memory. Sessions are always
// short-lived: closed on completion, error, cancel, disconnect, or idle
// timeout (plus an idle_in_transaction_session_timeout backstop in PG).

export const SESSION_IDLE_MS = 5 * 60 * 1000

/** A cursor session is an open transaction holding a server-side cursor; a
 * transaction session is a user-opened transaction with no cursor. Both pin
 * their client until the cursor is consumed, the user ends the transaction,
 * or the idle reaper rolls them back. */
export type SessionKind = 'cursor' | 'transaction'

interface Session {
  connId: string
  client: PoolClient
  kind: SessionKind
  transactionId: string | null
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

export function transactionState(key: string): TransactionState {
  const s = sessions.get(key)
  const transactionId = s?.kind === 'transaction' && !s.closeRequested ? s.transactionId : null
  return { transactionId, transactionOpen: transactionId !== null }
}

export function parseTransactionId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value
  throw Object.assign(new Error('Invalid transaction id'), { statusCode: 400 })
}

/** Omitted by legacy/internal callers; the browser always sends its expectation. */
export function assertTransaction(key: string, expected: string | null | undefined): void {
  if (expected === undefined) return
  const current = transactionState(key)
  if (current.transactionId !== expected) {
    throw Object.assign(new Error('The tab transaction ended or changed. Nothing was executed; review the transaction state before retrying.'), {
      statusCode: 409, code: 'TRANSACTION_CHANGED', ...current,
    })
  }
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
  kind: SessionKind = 'cursor',
): void {
  const prev = sessions.get(key)
  if (prev?.timer) clearTimeout(prev.timer)
  const s: Session = {
    connId, client, kind, cursor, pendingRow, timer: null, busy: false, closeRequested: false,
    transactionId: kind === 'transaction' ? randomUUID() : null,
  }
  sessions.set(key, s)
  // Arm the reaper whenever a transaction may be left open.
  if (cursor || kind === 'transaction') armReaper(key, s)
}

export function beginSession(key: string): Session | undefined {
  const s = sessions.get(key)
  if (!s || s.busy) return undefined
  s.busy = true
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  return s
}

async function releaseSession(key: string, s: Session, mode: 'commit' | 'rollback' | 'none'): Promise<void> {
  if (sessions.get(key) !== s) return
  sessions.delete(key)
  if (s.timer) clearTimeout(s.timer)
  let commitError: unknown
  if (mode !== 'none') {
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
  mode: 'keep' | 'commit' | 'rollback' | 'none',
): Promise<void> {
  if (sessions.get(key) !== s) return
  if (mode === 'keep' && !s.closeRequested) {
    s.busy = false
    if (s.cursor || s.kind === 'transaction') armReaper(key, s)
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
