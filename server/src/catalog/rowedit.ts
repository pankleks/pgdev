import { ident } from '../sqlident.js'
import type { EditableGrid } from '../schema-types.js'

// Row-editor catalog access: resolves a table reference from a plain SELECT
// to the identity information an UPDATE needs (real columns, generated flags,
// primary key). Everything the browser sends is re-validated against this
// live read — the client's `editable` metadata is advisory only.

/** Minimal query surface shared by Pool and PoolClient. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface RowEditColumn {
  name: string
  /** format_type output, e.g. `integer`, `numeric`, `jsonb`. */
  type: string
  generated: boolean
  pk: boolean
  nullable: boolean
}

export interface RowEditInfo {
  oid: string
  /** Canonical catalog names, never the caller's spelling. */
  schema: string
  name: string
  columns: RowEditColumn[]
  /** Primary key column names, in key order. */
  pk: string[]
}

const TABLE_SQL = `
SELECT c.oid::text AS oid, c.relkind::text AS relkind,
  n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = to_regclass($1)`

const COLUMNS_SQL = `
SELECT a.attname AS name,
  format_type(a.atttypid, NULL) AS type,
  a.attgenerated <> '' AS generated,
  NOT a.attnotnull AS nullable
FROM pg_attribute a
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`

const PK_SQL = `
SELECT a.attname AS name, array_position(con.conkey, a.attnum) AS ord
FROM pg_constraint con
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
WHERE con.conrelid = $1::oid AND con.contype = 'p'
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY ord`

/**
 * Resolve schema + table to its editable identity. Returns null when the name
 * does not resolve to an ordinary or partitioned table (views, foreign tables,
 * sequences, missing relations), so callers can treat "not editable" as the
 * normal outcome rather than an error.
 */
export async function fetchRowEditInfo(
  db: Queryable,
  schema: string | null,
  table: string,
): Promise<RowEditInfo | null> {
  const reg = schema ? `${ident(schema)}.${ident(table)}` : ident(table)
  const found = await db.query(TABLE_SQL, [reg])
  const row = found.rows[0]
  if (!row) return null
  const relkind = String(row.relkind)
  if (relkind !== 'r' && relkind !== 'p') return null

  const [colRes, pkRes] = await Promise.all([
    db.query(COLUMNS_SQL, [row.oid]),
    db.query(PK_SQL, [row.oid]),
  ])
  const pk = pkRes.rows.map((r) => String(r.name))
  const pkSet = new Set(pk)
  const columns: RowEditColumn[] = colRes.rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    generated: r.generated === true,
    pk: pkSet.has(String(r.name)),
    nullable: r.nullable === true,
  }))
  return {
    oid: String(row.oid),
    schema: String(row.schema),
    name: String(row.name),
    columns,
    pk,
  }
}

/**
 * Decide whether a result's columns identify rows of this table uniquely:
 * every primary-key column must appear exactly once in the result (an alias,
 * duplicate or missing PK column would make the WHERE clause ambiguous).
 * `allowed` restricts editability to the statement's plain column references
 * (null means the select list was `*`). Returns null when the result is not
 * row-editable.
 */
export function editableGrid(
  info: RowEditInfo,
  resultColumns: string[],
  allowed: string[] | null,
): EditableGrid | null {
  if (!info.pk.length) return null
  const counts = new Map<string, number>()
  for (const c of resultColumns) counts.set(c, (counts.get(c) ?? 0) + 1)
  for (const col of info.pk) {
    if (counts.get(col) !== 1) return null
  }
  const allowedSet = allowed ? new Set(allowed) : null
  const columns = info.columns
    .filter((c) => counts.get(c.name) === 1 && (!allowedSet || allowedSet.has(c.name)))
    .map((c) => ({ name: c.name, pk: c.pk, generated: c.generated, nullable: c.nullable }))
  return { schema: info.schema, table: info.name, pk: [...info.pk], columns }
}
