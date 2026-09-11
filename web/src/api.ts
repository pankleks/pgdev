import type { ConnectionConfig, FetchMoreResponse, QueryResponse, SchemaData } from './types'

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`)
  }
  return body as T
}

export const api = {
  connect(config: ConnectionConfig): Promise<{ id: string }> {
    return fetch('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }).then((r) => unwrap<{ id: string }>(r))
  },

  disconnect(id: string): Promise<void> {
    return fetch(`/api/connections/${id}`, { method: 'DELETE' }).then(() => undefined)
  },

  schema(id: string): Promise<SchemaData> {
    return fetch(`/api/connections/${id}/schema`).then((r) => unwrap<SchemaData>(r))
  },

  ddl(id: string, type: string, schema: string, name: string, oid?: string, parent?: string): Promise<{ ddl: string }> {
    const params = new URLSearchParams({ type, schema, name })
    if (oid) params.set('oid', oid)
    if (parent) params.set('parent', parent)
    return fetch(`/api/connections/${id}/ddl?${params}`).then((r) => unwrap<{ ddl: string }>(r))
  },

  query(id: string, sql: string, tabKey: string): Promise<QueryResponse> {
    return fetch(`/api/connections/${id}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql, maxRows: 500, tabKey }),
    }).then((r) => unwrap<QueryResponse>(r))
  },

  cancel(id: string, tabKey: string): Promise<{ ok: boolean }> {
    return fetch(`/api/connections/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabKey }),
    }).then((r) => unwrap<{ ok: boolean }>(r))
  },

  fetchMore(id: string, tabKey: string): Promise<FetchMoreResponse> {
    return fetch(`/api/connections/${id}/query/more`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabKey, maxRows: 500 }),
    }).then((r) => unwrap<FetchMoreResponse>(r))
  },
}
