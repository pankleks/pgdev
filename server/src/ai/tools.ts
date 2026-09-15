// MCP tool implementations for the AI agent. Everything is injected (pool
// access, DDL generation, the read-only runner and the browser bridge), so the
// tool layer is pure enough to unit-test with fakes: no Fastify, no pool, no
// SSE in here.
//
// Mutations are never executed, and the agent never runs the editor: `query`
// refuses anything that is not a plain read before it reaches the database (and
// the database itself refuses writes in the read-only transaction it runs in),
// while `set_active_query` / `open_query_tab` put generated SQL in front of the
// user, who runs it.

import type { MappedData, BatchOutcome } from '../queryexec.js'
import type { SchemaData } from '../schema-types.js'
import { BridgeError, windowProblem, type Bridge } from './bridge.js'
import { isReadOnlySql } from './readonly.js'

export interface AiLimits {
  /** Rows returned to the agent per result. */
  maxRows: number
  /** Bytes of row JSON returned to the agent per result. */
  maxBytes: number
}

export const DEFAULT_AI_LIMITS: AiLimits = { maxRows: 100, maxBytes: 64 * 1024 }

export const AI_TAB_TITLE = 'AI'

export interface DdlTarget {
  type: string
  schema: string
  name: string
  oid?: string
  parent?: string
}

export interface AiDeps {
  /** Ids of the pools the server currently holds. */
  connectionIds(): string[]
  getSchema(connectionId: string): Promise<SchemaData>
  getDdl(connectionId: string, target: DdlTarget): Promise<string>
  /** Execute a read-only batch; the implementation wraps it in a read-only transaction. */
  runReadOnly(connectionId: string, sql: string, maxRows: number): Promise<BatchOutcome>
  bridge: Bridge
  limits?: AiLimits
}

export type AiToolResult = { ok: true; result: unknown } | { ok: false; error: string }
export type AiTool = (args: Record<string, unknown>) => Promise<AiToolResult>

interface BrowserContext {
  connectionId: string | null
  connectionLabel: string
  activeKey: string | null
  tabs: { key: string; title: string; readOnly: boolean }[]
}

interface ActiveQuery {
  sql: string
  readOnly: boolean
}

const MAX_RELATIONS = 200
const DDL_TYPES = ['table', 'view', 'function', 'index', 'constraint', 'trigger', 'type']
const NOT_CONNECTED =
  'pgDEV is not connected to a database. Open a connection in pgDEV, then ask again.'

function fail(error: string): AiToolResult {
  return { ok: false, error }
}

function messageOf(err: unknown): string {
  if (err instanceof BridgeError) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** The editor tools need exactly one listening window; null when there is one. */
function windowError(bridge: Bridge): string | null {
  return windowProblem(bridge.count())?.message ?? null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Cap rows by count and by serialized size; reports whether anything was cut. */
function capRows(
  rows: unknown[][],
  maxRows: number,
  maxBytes: number,
): { rows: unknown[][]; truncated: boolean } {
  const kept: unknown[][] = []
  let bytes = 0
  for (const row of rows) {
    if (kept.length >= maxRows) return { rows: kept, truncated: true }
    const size = JSON.stringify(row)?.length ?? 0
    if (bytes + size > maxBytes) return { rows: kept, truncated: true }
    bytes += size
    kept.push(row)
  }
  return { rows: kept, truncated: false }
}

export function createAiTools(deps: AiDeps): Record<string, AiTool> {
  const bridge = deps.bridge
  const limits = deps.limits ?? DEFAULT_AI_LIMITS

  async function context(): Promise<BrowserContext | null> {
    if (!bridge.connected()) return null
    try {
      return (await bridge.request('get-context')) as BrowserContext
    } catch {
      return null
    }
  }

  /**
   * The connection the agent works on: the one open in the pgDEV window, or —
   * with no window listening — the only pool the server holds. There is no way
   * to pick another one; the agent sees exactly what the user has open.
   */
  async function activeConnection(): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const ctx = await context()
    const ids = deps.connectionIds()
    if (ctx?.connectionId) {
      if (ids.includes(ctx.connectionId)) return { ok: true, id: ctx.connectionId }
      return { ok: false, error: NOT_CONNECTED }
    }
    if (ids.length === 1) return { ok: true, id: ids[0] as string }
    if (!ids.length) return { ok: false, error: NOT_CONNECTED }
    return {
      ok: false,
      error:
        `pgDEV has ${ids.length} connections open and no window listening to say which one is in ` +
        'use. Keep a single connection open in a single pgDEV window.',
    }
  }

  function dataResults(outcome: BatchOutcome): MappedData[] {
    if (outcome.kind !== 'ok') return []
    return outcome.results.filter((r): r is MappedData => r.kind === 'data')
  }

  async function query(args: Record<string, unknown>): Promise<AiToolResult> {
    const sql = asString(args.sql)
    if (!sql || !sql.trim()) return fail('"sql" is required.')
    const readOnly = isReadOnlySql(sql)
    if (!readOnly.ok) return fail(readOnly.reason)

    const connection = await activeConnection()
    if (!connection.ok) return fail(connection.error)

    let outcome: BatchOutcome
    try {
      outcome = await deps.runReadOnly(connection.id, sql, limits.maxRows)
    } catch (err) {
      return fail(messageOf(err))
    }
    if (outcome.kind === 'error') {
      const detail = outcome.error.kind === 'sql' ? outcome.error.message : outcome.error.kind
      return fail(detail)
    }

    const data = dataResults(outcome)
    if (!data.length) return fail('The statement returned no rows (only commands ran).')

    const results = data.map((item, index) => {
      const capped = capRows(item.rows, limits.maxRows, limits.maxBytes)
      return {
        statement: index + 1,
        columns: item.columns,
        columnTypes: item.columnTypes,
        rows: capped.rows,
        rowCount: item.rowCount,
        truncated: capped.truncated || item.truncated || item.limited,
        totalRowCount: item.totalRowCount,
      }
    })

    // Mirror the first result in the UI: the agent's SQL in a tab plus the
    // rows. Best effort and not awaited — a slow or busy window must not stall
    // the tool call.
    const first = results[0]
    // Mirror only when a single window is listening: with several, the rows
    // would land in each of them and the agent's action would be ambiguous.
    const listening = bridge.count() === 1
    if (listening) {
      void bridge
        .request('show-result', {
          title: AI_TAB_TITLE,
          sql,
          columns: first?.columns ?? [],
          columnTypes: first?.columnTypes ?? [],
          rows: first?.rows ?? [],
          rowCount: first?.rowCount ?? 0,
          truncated: first?.truncated ?? false,
        })
        .catch(() => undefined)
    }

    return { ok: true, result: { results, shown: listening } }
  }

  async function getSchema(args: Record<string, unknown>): Promise<AiToolResult> {
    const connection = await activeConnection()
    if (!connection.ok) return fail(connection.error)
    let data: SchemaData
    try {
      data = await deps.getSchema(connection.id)
    } catch (err) {
      return fail(messageOf(err))
    }
    const schemaFilter = asString(args.schema)
    const tableFilter = asString(args.table)
    const match = (schema: string, name: string): boolean =>
      (!schemaFilter || schema === schemaFilter) && (!tableFilter || name === tableFilter)

    const tables = data.tables.filter((t) => match(t.schema, t.name))
    const views = data.views.filter((v) => match(v.schema, v.name))
    const relationCount = tables.length + views.length
    const keep = <T,>(list: T[]): T[] =>
      relationCount > MAX_RELATIONS ? list.slice(0, MAX_RELATIONS) : list

    return {
      ok: true,
      result: {
        tables: keep(tables).map((t) => ({
          schema: t.schema,
          name: t.name,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            default: c.defaultValue,
          })),
        })),
        views: keep(views).map((v) => ({
          schema: v.schema,
          name: v.name,
          materialized: v.materialized,
          columns: v.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable })),
        })),
        functions: data.functions
          .filter((f) => match(f.schema, f.name))
          .map((f) => ({
            schema: f.schema,
            name: f.name,
            kind: f.kind,
            arguments: f.arguments && f.arguments.length ? f.arguments : f.args,
            returns: f.returns,
            comment: f.comment ?? null,
          })),
        types: data.types
          .filter((t) => match(t.schema, t.name))
          .map((t) => ({ schema: t.schema, name: t.name, kind: t.kind, detail: t.detail })),
        truncated: relationCount > MAX_RELATIONS,
      },
    }
  }

  async function getDdl(args: Record<string, unknown>): Promise<AiToolResult> {
    const type = asString(args.type)
    const schema = asString(args.schema)
    const name = asString(args.name)
    if (!type || !DDL_TYPES.includes(type)) return fail(`"type" must be one of: ${DDL_TYPES.join(', ')}.`)
    if (!schema || !name) return fail('"schema" and "name" are required.')
    const connection = await activeConnection()
    if (!connection.ok) return fail(connection.error)
    try {
      const ddl = await deps.getDdl(connection.id, {
        type,
        schema,
        name,
        oid: asString(args.oid) ?? undefined,
        parent: asString(args.parent) ?? undefined,
      })
      return { ok: true, result: { ddl } }
    } catch (err) {
      return fail(messageOf(err))
    }
  }

  async function getActiveQuery(): Promise<AiToolResult> {
    const problem = windowError(bridge)
    if (problem) return fail(problem)
    try {
      const active = (await bridge.request('get-active-query')) as ActiveQuery
      return { ok: true, result: active }
    } catch (err) {
      return fail(messageOf(err))
    }
  }

  async function setActiveQuery(args: Record<string, unknown>): Promise<AiToolResult> {
    const sql = asString(args.sql)
    if (!sql || !sql.trim()) return fail('"sql" is required.')
    const mode = asString(args.mode) ?? 'replace'
    if (!['replace', 'append', 'insert'].includes(mode)) {
      return fail('"mode" must be replace, append or insert.')
    }
    const problem = windowError(bridge)
    if (problem) return fail(problem)
    try {
      const applied = await bridge.request('set-active-query', { sql, mode })
      return { ok: true, result: applied }
    } catch (err) {
      return fail(messageOf(err))
    }
  }

  async function openQueryTab(args: Record<string, unknown>): Promise<AiToolResult> {
    const sql = asString(args.sql)
    if (!sql || !sql.trim()) return fail('"sql" is required.')
    const title = asString(args.title) ?? AI_TAB_TITLE
    const problem = windowError(bridge)
    if (problem) return fail(problem)
    try {
      const opened = await bridge.request('open-query-tab', { sql, title })
      return { ok: true, result: opened }
    } catch (err) {
      return fail(messageOf(err))
    }
  }

  return {
    get_schema: getSchema,
    get_ddl: getDdl,
    query,
    get_active_query: getActiveQuery,
    set_active_query: setActiveQuery,
    open_query_tab: openQueryTab,
  }
}
