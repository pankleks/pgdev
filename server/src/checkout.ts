import type { PoolClient } from 'pg'
import { closeSessionsForClient } from './sessions.js'
import { pgErrorMessage } from './pgerror.js'

// The pool 'error' handler in routes/connections.ts only covers *idle*
// clients. A cursor session keeps its client checked out for up to the idle
// timeout, and that same timeout (`idle_in_transaction_session_timeout`) can
// terminate the backend while the client is checked out. node-postgres then
// emits 'error' on the checked-out Client, which has no listener, and an
// unhandled 'error' event takes down the whole API process. Installing a
// per-checkout listener keeps the process alive and drops the dead session.

interface ErrorHandled {
  handler: (err: unknown) => void
  release: () => void
}

const installed = new WeakMap<PoolClient, ErrorHandled>()

/**
 * Attach an error handler to a freshly checked-out client. Safe to call more
 * than once for the same client; the handler is removed when the client is
 * released back to the pool (so the pool's own idle handling resumes).
 */
export function guardCheckedOutClient(client: PoolClient): void {
  const existing = installed.get(client)
  if (existing) {
    client.removeListener('error', existing.handler)
    if (client.release !== existing.release) existing.release = client.release
  }

  const handler = (err: unknown): void => {
    console.error(`pg client error: ${pgErrorMessage(err, 'Database connection error')}`)
    void closeSessionsForClient(client)
  }

  const record: ErrorHandled = { handler, release: client.release }
  installed.set(client, record)
  client.on('error', handler)

  const release = record.release
  client.release = (err?: Error | boolean) => {
    client.removeListener('error', handler)
    installed.delete(client)
    client.release = release
    return (release as (e?: Error | boolean) => void).call(client, err)
  }
}
