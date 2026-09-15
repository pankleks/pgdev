// Server → browser control channel for the AI tools. The browser subscribes to
// an SSE stream on load and answers each action over HTTP, so a tool can read
// live editor state (active tab) and change it (open a tab, set the query, show
// a result). An action is only delivered when exactly one window is listening:
// with none there is nothing to act on, and with several the agent has no way
// to know which editor the user means — broadcasting would run the action in
// every open window, so both cases fail fast with a clear message instead.

export type BridgeFailure = 'no-window' | 'multiple' | 'timeout' | 'disconnected'

export class BridgeError extends Error {
  readonly code: BridgeFailure

  constructor(code: BridgeFailure, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** Why the agent cannot act on a window count, or null when exactly one listens. */
export function windowProblem(count: number): { code: BridgeFailure; message: string } | null {
  if (count === 1) return null
  if (count === 0) {
    return {
      code: 'no-window',
      message: 'No pgDEV window is open. Open pgDEV in a browser so the agent can reach the editor.',
    }
  }
  return {
    code: 'multiple',
    message:
      `${count} pgDEV windows are listening to the AI bridge. Close the extra ones so the ` +
      'agent knows which editor to act on.',
  }
}

export interface BridgeAction {
  id: string
  action: string
  args: Record<string, unknown>
}

export interface Bridge {
  /** Register an SSE writer; the returned function unsubscribes it. */
  subscribe(write: (event: string) => void): () => void
  /** Number of browser windows currently subscribed. */
  count(): number
  /** True while at least one browser window is subscribed. */
  connected(): boolean
  /** Ask the browser to perform an action and await its answer. */
  request(action: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** Deliver a browser's answer; false when the id is unknown or already done. */
  resolve(id: string, payload: unknown, error?: string | null): boolean
}

export const DEFAULT_BRIDGE_TIMEOUT_MS = 15000

export function createBridge(defaultTimeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS): Bridge {
  const writers = new Set<(event: string) => void>()
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  let seq = 0

  function failAll(code: BridgeFailure, message: string): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new BridgeError(code, message))
    }
    pending.clear()
  }

  return {
    subscribe(write) {
      writers.add(write)
      return () => {
        writers.delete(write)
        if (!writers.size) {
          failAll('disconnected', 'The pgDEV window closed before the agent finished.')
        }
      }
    },

    count() {
      return writers.size
    },

    connected() {
      return writers.size > 0
    },

    request(action, args = {}, timeoutMs = defaultTimeoutMs) {
      const problem = windowProblem(writers.size)
      if (problem) {
        return Promise.reject(new BridgeError(problem.code, problem.message))
      }
      const id = `a${++seq}-${Date.now().toString(36)}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new BridgeError('timeout', 'The pgDEV window did not answer in time.'))
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, { resolve, reject, timer })
        const event = JSON.stringify({ id, action, args } satisfies BridgeAction)
        for (const write of writers) {
          try {
            write(event)
          } catch {
            // A dead writer is dropped by its own close handler.
          }
        }
      })
    },

    resolve(id, payload, error) {
      const entry = pending.get(id)
      if (!entry) return false
      pending.delete(id)
      clearTimeout(entry.timer)
      if (error) entry.reject(new BridgeError('disconnected', error))
      else entry.resolve(payload)
      return true
    },
  }
}
