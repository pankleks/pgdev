import type {
  AiConfig,
  AiLimits,
  ConnectionConfig,
  FetchMoreResponse,
  QueryResponse,
  RowUpdateRequest,
  RowUpdateResponse,
  SchemaData,
  TableEditRequest,
  TableEditResponse,
  TableEditState,
} from './types'

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errBody = body as { error?: string; code?: string | null }
    const err = new Error(errBody.error || `Request failed (${res.status})`)
    ;(err as Error & { code?: string | null }).code = errBody.code ?? null
    throw err
  }
  return body as T
}

export const api = {
  version(): Promise<string> {
    return fetch('/api/version')
      .then((r) => unwrap<{ version: string }>(r))
      .then((b) => b.version)
  },

  connect(config: ConnectionConfig): Promise<{ id: string; pgVersion?: string }> {
    return fetch('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }).then((r) => unwrap<{ id: string; pgVersion?: string }>(r))
  },

  disconnect(id: string): Promise<void> {
    return fetch(`/api/connections/${id}`, { method: 'DELETE' })
      .then((r) => unwrap<unknown>(r))
      .then(() => undefined)
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

  closeSession(id: string, tabKey: string): Promise<{ ok: boolean }> {
    return fetch(`/api/connections/${id}/query/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabKey }),
    }).then((r) => unwrap<{ ok: boolean }>(r))
  },

  tableEditState(id: string, oid: string): Promise<TableEditState> {
    return fetch(`/api/connections/${id}/tableedit/${oid}`).then((r) => unwrap<TableEditState>(r))
  },

  tableEditSubmit(id: string, oid: string, request: TableEditRequest): Promise<TableEditResponse> {
    return fetch(`/api/connections/${id}/tableedit/${oid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }).then((r) => unwrap<TableEditResponse>(r))
  },

  updateRow(id: string, request: RowUpdateRequest): Promise<RowUpdateResponse> {
    return fetch(`/api/connections/${id}/row-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }).then((r) => unwrap<RowUpdateResponse>(r))
  },

  /** The AI/MCP configuration; `enabled` is false when the server has AI off. */
  aiConfig(): Promise<AiConfig> {
    return fetch('/api/ai/config').then((r) => unwrap<AiConfig>(r))
  },

  /** Tell the server how much of a result set the agent may read. */
  aiLimits(limits: AiLimits): Promise<AiLimits> {
    return fetch('/api/ai/limits', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(limits),
    }).then((r) => unwrap<AiLimits>(r))
  },

  /** Hand a bridge action's outcome back to the waiting tool call. */
  aiBridgeResult(id: string, result: unknown, error: string | null): Promise<{ ok: boolean }> {
    return fetch('/api/ai/bridge/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, result, error }),
    }).then((r) => unwrap<{ ok: boolean }>(r))
  },
}
