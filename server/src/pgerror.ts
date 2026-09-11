// Normalize pg / network errors into a non-empty human-readable message.
// node-postgres usually populates `message`, but some failures (e.g.
// ECONNREFUSED with certain Node versions) can surface with an empty
// message, which previously produced `{"error":""}` on the client.
export function pgErrorMessage(err: unknown, fallback = 'Connection failed'): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; detail?: unknown }
    const message = typeof e.message === 'string' ? e.message.trim() : ''
    if (message) return message
    const detail = typeof e.detail === 'string' ? e.detail.trim() : ''
    const code = typeof e.code === 'string' && e.code ? ` (code ${e.code})` : ''
    if (detail) return `${detail}${code}`
    if (code) return `Connection failed${code}`
  }
  const text = String(err ?? '').trim()
  if (text && text !== '[object Object]') return text
  return fallback
}
