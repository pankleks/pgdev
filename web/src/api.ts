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
  TransactionState,
} from './types'

export type ApiError = Error & Partial<TransactionState> & { code?: string | null; position?: string | null }

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errBody = body as Partial<TransactionState> & { error?: string; code?: string | null; position?: string | null }
    const err: ApiError = new Error(errBody.error || `Request failed (${res.status})`)
    ;(err as Error & { code?: string | null }).code = errBody.code ?? null
    // PostgreSQL 1-based error offset relative to the submitted batch (null
    // when the server has none). Carried for editor markers.
    ;(err as Error & { position?: string | null }).position = errBody.position ?? null
    if (errBody.transactionId !== undefined) {
      err.transactionId = errBody.transactionId
      err.transactionOpen = errBody.transactionOpen
    }
    throw err
  }
  return body as T
}

/** One JSON round-trip: the method, the optional body, and the error mapping
 * are the same for every endpoint, so the callers name only the route. */
async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = body === undefined
    ? await fetch(url, { method })
    : await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
  return unwrap<T>(res)
}

export const api = {
  version(): Promise<string> {
    return send<{ version: string }>('GET', '/api/version').then((b) => b.version)
  },

  connect(config: ConnectionConfig): Promise<{ id: string; pgVersion?: string }> {
    return send('POST', '/api/connections', config)
  },

  disconnect(id: string): Promise<void> {
    return send<unknown>('DELETE', `/api/connections/${id}`).then(() => undefined)
  },

  schema(id: string): Promise<SchemaData> {
    return send('GET', `/api/connections/${id}/schema`)
  },

  ddl(id: string, type: string, schema: string, name: string, oid?: string, parent?: string): Promise<{ ddl: string }> {
    const params = new URLSearchParams({ type, schema, name })
    if (oid) params.set('oid', oid)
    if (parent) params.set('parent', parent)
    return send('GET', `/api/connections/${id}/ddl?${params}`)
  },

  query(id: string, sql: string, tabKey: string, transactionId: string | null): Promise<QueryResponse> {
    return send('POST', `/api/connections/${id}/query`, { sql, maxRows: 500, tabKey, transactionId })
  },

  cancel(id: string, tabKey: string): Promise<{ ok: boolean }> {
    return send('POST', `/api/connections/${id}/cancel`, { tabKey })
  },

  fetchMore(id: string, tabKey: string): Promise<FetchMoreResponse> {
    return send('POST', `/api/connections/${id}/query/more`, { tabKey, maxRows: 500 })
  },

  closeSession(id: string, tabKey: string): Promise<{ ok: boolean }> {
    return send('POST', `/api/connections/${id}/query/close`, { tabKey })
  },

  tableEditState(id: string, oid: string): Promise<TableEditState> {
    return send('GET', `/api/connections/${id}/tableedit/${oid}`)
  },

  tableEditSubmit(id: string, oid: string, request: TableEditRequest): Promise<TableEditResponse> {
    return send('POST', `/api/connections/${id}/tableedit/${oid}`, request)
  },

  updateRow(id: string, request: RowUpdateRequest): Promise<RowUpdateResponse> {
    return send('POST', `/api/connections/${id}/row-update`, request)
  },

  /** The AI/MCP configuration; `enabled` is false when the server has AI off. */
  aiConfig(): Promise<AiConfig> {
    return send('GET', '/api/ai/config')
  },

  /** Tell the server how much of a result set the agent may read. */
  aiLimits(limits: AiLimits): Promise<AiLimits> {
    return send('PUT', '/api/ai/limits', limits)
  },

  /** Hand a bridge action's outcome back to the waiting tool call. */
  aiBridgeResult(id: string, result: unknown, error: string | null): Promise<{ ok: boolean }> {
    return send('POST', '/api/ai/bridge/result', { id, result, error })
  },
}
