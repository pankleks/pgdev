import type { Pool } from 'pg'
import { createHash } from 'node:crypto'
import type {
  TableEditColumnInput,
  TableEditColumnState,
  TableEditKeyRef,
  TableEditRequest,
  TableEditState,
} from '../schema-types.js'

// Table-editor catalog access: one read turns a table into the dialog state,
// and a submitted dialog state is diffed against a fresh live read into a
// change-only ALTER script. The browser payload is advisory only — every
// read-only flag (pk, unique keys, identity/generated/serial) is recomputed
// here, and the final diff always runs against what PostgreSQL actually has.

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

export interface LiveColumn {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  description: string | null
  pk: boolean
  locked: boolean
  lockKind?: 'identity' | 'generated' | 'serial'
}

export interface LiveTable {
  relkind: string
  schema: string
  name: string
  description: string | null
  columns: LiveColumn[]
}

export type DiffError =
  | { kind: 'locked'; column: string }
  | { kind: 'pk-drop'; column: string }
  | { kind: 'pk-nullable'; column: string }
  | { kind: 'unknown-column'; id: string }
  | { kind: 'duplicate'; column: string }
  | { kind: 'empty-name' }
  | { kind: 'empty-type'; column: string }

export type DiffOutcome =
  | { kind: 'ok'; statements: string[] }
  | { kind: 'error'; error: DiffError }

/** Collapse runs of whitespace so a re-typed default that only differs in
 * spacing is not emitted as a pointless SET DEFAULT. */
function normalizeExpr(expr: string | null): string {
  if (expr === null) return ''
  return expr.trim().replace(/\s+/g, ' ')
}

/** The editor treats an empty description as "no comment". */
function normalizeText(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}

const NEW_ID = /^new:\d+$/

export function isNewColumnId(id: string): boolean {
  return NEW_ID.test(id)
}

/**
 * Stable hash of a live editor state. The dialog echoes it back on submit; a
 * mismatch means the table changed since it was loaded, and diffing the stale
 * column set would drop anything added in the meantime.
 */
export function stateFingerprint(state: Omit<TableEditState, 'fingerprint'>): string {
  const parts = [
    state.oid,
    state.schema,
    state.name,
    state.relkind,
    state.description ?? '',
    ...state.columns.map((c) =>
      [
        c.id,
        c.name,
        c.type,
        c.nullable ? '1' : '0',
        c.defaultValue ?? '',
        c.description ?? '',
        c.pk ? '1' : '0',
        (c.uks ?? []).map((u) => u.label).join(','),
        c.locked ? '1' : '0',
        c.lockKind ?? '',
      ].join('\u0001'),
    ),
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/**
 * Compare the desired column set against the live catalog and produce the
 * ALTER statements, in dependency-safe order: drops, renames, per-column
 * alters, adds, then comments. Pure — the routes call it with a freshly
 * fetched `LiveTable`, and the unit suite drives it directly.
 */
export function diffTableEdit(live: LiveTable, req: TableEditRequest): DiffOutcome {
  const table = `${ident(live.schema)}.${ident(live.name)}`
  const statements: string[] = []

  const ids = new Set<string>()
  for (const col of req.columns) {
    if (!col.id || ids.has(col.id)) return { kind: 'error', error: { kind: 'duplicate', column: col.id } }
    ids.add(col.id)
  }
  const byId = new Map(req.columns.map((col) => [col.id, col]))

  const finalNames = new Set<string>()
  for (const [id, col] of byId) {
    const name = col.name.trim()
    if (!name) return { kind: 'error', error: { kind: 'empty-name' } }
    if (!isNewColumnId(id) && !live.columns.some((c) => c.name === id)) {
      return { kind: 'error', error: { kind: 'unknown-column', id } }
    }
    if (finalNames.has(name)) return { kind: 'error', error: { kind: 'duplicate', column: name } }
    finalNames.add(name)
  }

  // --- drops (before renames, so a rename may reuse a dropped name) ---------
  for (const col of live.columns) {
    if (byId.has(col.name)) continue
    if (col.pk) return { kind: 'error', error: { kind: 'pk-drop', column: col.name } }
    statements.push(`ALTER TABLE ${table}\n  DROP COLUMN ${ident(col.name)}`)
  }

  // --- renames, then per-column alters (renamed names are final here) ------
  for (const col of live.columns) {
    const edit = byId.get(col.name)
    if (!edit) continue
    if (edit.name.trim() !== col.name) {
      statements.push(`ALTER TABLE ${table}\n  RENAME COLUMN ${ident(col.name)} TO ${ident(edit.name.trim())}`)
    }
    if (col.locked) {
      const typeChanged = normalizeExpr(edit.type) !== normalizeExpr(col.type)
      const defaultChanged = normalizeExpr(edit.defaultValue) !== normalizeExpr(col.defaultValue)
      const nullableLocked = col.lockKind !== 'serial'
      const nullableChanged = nullableLocked && edit.nullable !== col.nullable
      if (typeChanged || defaultChanged || nullableChanged) {
        return { kind: 'error', error: { kind: 'locked', column: col.name } }
      }
    }
    if (col.pk && edit.nullable) {
      return { kind: 'error', error: { kind: 'pk-nullable', column: col.name } }
    }
    const type = normalizeExpr(edit.type)
    if (!col.locked && type !== normalizeExpr(col.type)) {
      if (!type) return { kind: 'error', error: { kind: 'empty-type', column: col.name } }
      statements.push(`ALTER TABLE ${table}\n  ALTER COLUMN ${ident(edit.name.trim())} TYPE ${type}`)
    }
    if (!edit.nullable && col.nullable) {
      statements.push(`ALTER TABLE ${table}\n  ALTER COLUMN ${ident(edit.name.trim())} SET NOT NULL`)
    } else if (edit.nullable && !col.nullable) {
      statements.push(`ALTER TABLE ${table}\n  ALTER COLUMN ${ident(edit.name.trim())} DROP NOT NULL`)
    }
    const reqDefault = normalizeExpr(edit.defaultValue)
    if (reqDefault !== normalizeExpr(col.defaultValue)) {
      if (reqDefault === '') {
        statements.push(`ALTER TABLE ${table}\n  ALTER COLUMN ${ident(edit.name.trim())} DROP DEFAULT`)
      } else {
        statements.push(`ALTER TABLE ${table}\n  ALTER COLUMN ${ident(edit.name.trim())} SET DEFAULT ${reqDefault}`)
      }
    }
  }

  // --- added columns, in dialog order --------------------------------------
  for (const col of req.columns) {
    if (!isNewColumnId(col.id)) continue
    const name = col.name.trim()
    const type = normalizeExpr(col.type)
    if (!type) return { kind: 'error', error: { kind: 'empty-type', column: name } }
    const parts = [`ADD COLUMN ${ident(name)} ${type}`]
    const reqDefault = normalizeExpr(col.defaultValue)
    if (reqDefault !== '') parts.push(`DEFAULT ${reqDefault}`)
    if (!col.nullable) parts.push('NOT NULL')
    statements.push(`ALTER TABLE ${table}\n  ${parts.join(' ')}`)
  }

  // --- comments last (a dropped column's comment must not be emitted) ------
  for (const col of live.columns) {
    const edit = byId.get(col.name)
    if (!edit) continue
    const reqDesc = normalizeText(edit.description)
    if (reqDesc !== normalizeText(col.description)) {
      statements.push(
        `COMMENT ON COLUMN ${table}.${ident(edit.name.trim())} IS ${reqDesc === null ? 'NULL' : quoteLiteral(reqDesc)}`,
      )
    }
  }
  for (const col of req.columns) {
    if (!isNewColumnId(col.id)) continue
    const reqDesc = normalizeText(col.description)
    if (reqDesc !== null) {
      statements.push(
        `COMMENT ON COLUMN ${table}.${ident(col.name.trim())} IS ${quoteLiteral(reqDesc)}`,
      )
    }
  }
  const reqTableDesc = normalizeText(req.description)
  if (reqTableDesc !== normalizeText(live.description)) {
    statements.push(
      `COMMENT ON TABLE ${table} IS ${reqTableDesc === null ? 'NULL' : quoteLiteral(reqTableDesc)}`,
    )
  }

  return { kind: 'ok', statements }
}

const TABLE_SQL = `
SELECT c.relkind::text AS relkind, c.relispartition AS is_partition,
  n.nspname AS schema, c.relname AS name,
  obj_description(c.oid) AS description
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = $1::oid`

const COLUMNS_SQL = `
SELECT a.attnum AS attnum,
  a.attname AS name,
  format_type(a.atttypid, a.atttypmod) AS type,
  NOT a.attnotnull AS nullable,
  -- Identity defaults live in the sequence machinery, not pg_attrdef (and a
  -- PG17 adbin entry would render an internal node), so identity columns
  -- always surface without a default.
  CASE WHEN a.attidentity <> '' THEN NULL ELSE pg_get_expr(d.adbin, d.adrelid) END AS default_expr,
  col_description(a.attrelid, a.attnum) AS description,
  a.attidentity AS identity,
  a.attgenerated AS generated,
  pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`

const PK_SQL = `
SELECT DISTINCT a.attname AS name
FROM pg_constraint con
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
WHERE con.conrelid = $1::oid AND con.contype = 'p'
  AND a.attnum > 0 AND NOT a.attisdropped`

// Unique keys in catalog order: constraint-backed ones and standalone unique
// indexes (which carry their full definition), so a column unique only via
// `CREATE UNIQUE INDEX` gets its badge too. Key columns only — the INCLUDE
// tail of `indkey` is sliced off. Ordered by oid so the UK1/UK2/… numbering
// is deterministic across loads.
const UK_SQL = `
SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition, con.conkey AS conkey, con.oid AS ord
FROM pg_constraint con
WHERE con.conrelid = $1::oid AND con.contype = 'u'
UNION ALL
SELECT idx.relname AS name, pg_get_indexdef(idx.oid) AS definition,
  (i.indkey)[0:i.indnkeyatts-1] AS conkey, idx.oid AS ord
FROM pg_index i
JOIN pg_class idx ON idx.oid = i.indexrelid
WHERE i.indrelid = $1::oid AND i.indisunique AND NOT i.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = idx.oid)
ORDER BY ord`

// Outgoing foreign keys only — the display asks "does this column reference
// another table", not "what references this table". Ordered by oid so the
// FK1/FK2/… numbering is deterministic across loads.
const FK_SQL = `
SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition, con.conkey AS conkey
FROM pg_constraint con
WHERE con.conrelid = $1::oid AND con.contype = 'f'
ORDER BY con.oid`

export interface FkRow {
  name: string
  definition: string
  conkey: unknown
}

/**
 * Running-number key badges: FK1/UK1 for the first constraint (in the given
 * order), FK2/UK2 for the second, and so on — every column listed in a
 * constraint's key list shares that constraint's number, so a two-column key
 * reads `FK3`/`FK3` or `UK2`/`UK2`. Unknown attnums (dropped columns) are
 * skipped without disturbing the numbering. Pure — unit-tested directly.
 */
function keyLabels(
  rows: FkRow[],
  nameByAttnum: Map<number, string>,
  prefix: 'FK' | 'UK',
): Map<string, TableEditKeyRef[]> {
  const byColumn = new Map<string, TableEditKeyRef[]>()
  rows.forEach((row, index) => {
    const ref: TableEditKeyRef = {
      label: `${prefix}${index + 1}`,
      name: String(row.name),
      definition: String(row.definition),
    }
    const keys = Array.isArray(row.conkey) ? row.conkey : []
    for (const key of keys) {
      const column = nameByAttnum.get(Number(key))
      if (!column) continue
      const list = byColumn.get(column)
      if (list) list.push(ref)
      else byColumn.set(column, [ref])
    }
  })
  return byColumn
}

export function fkLabels(
  rows: FkRow[],
  nameByAttnum: Map<number, string>,
): Map<string, TableEditKeyRef[]> {
  return keyLabels(rows, nameByAttnum, 'FK')
}

export function ukLabels(
  rows: FkRow[],
  nameByAttnum: Map<number, string>,
): Map<string, TableEditKeyRef[]> {
  return keyLabels(rows, nameByAttnum, 'UK')
}

const SERIAL_TYPES = new Set(['smallint', 'integer', 'bigint'])

/** Read the live editor state for one editable table. Views, matviews, indexes,
 * sequences, foreign tables and partitions are rejected here, so both the read
 * and the submit routes agree on what may be edited. */
export async function fetchTableEditState(pool: Pool, oid: string): Promise<TableEditState> {
  const [tableRes, colsRes, pkRes, ukRes, fkRes] = await Promise.all([
    pool.query(TABLE_SQL, [oid]),
    pool.query(COLUMNS_SQL, [oid]),
    pool.query(PK_SQL, [oid]),
    pool.query(UK_SQL, [oid]),
    pool.query(FK_SQL, [oid]),
  ])
  const table = tableRes.rows[0]
  if (!table) {
    const err = new Error('Object not found')
    ;(err as Error & { statusCode: number }).statusCode = 404
    throw err
  }
  // A partition ('r' with relispartition) gets its shape from the parent, and
  // every other relation kind speaks different DDL.
  const relkind = String(table.relkind)
  if ((relkind !== 'r' && relkind !== 'p') || table.is_partition === true) {
    validationError('Only ordinary tables and partitioned parents can be edited')
  }
  const pkCols = new Set<string>(pkRes.rows.map((r) => String(r.name)))
  const nameByAttnum = new Map<number, string>()
  for (const row of colsRes.rows) nameByAttnum.set(Number(row.attnum), String(row.name))
  const fksByColumn = fkLabels(fkRes.rows as FkRow[], nameByAttnum)
  const uksByColumn = ukLabels(ukRes.rows as FkRow[], nameByAttnum)
  const columns: TableEditColumnState[] = colsRes.rows.map((row) => {
    const identity = String(row.identity ?? '') !== ''
    const generated = String(row.generated ?? '') !== ''
    const serial =
      !identity && row.sequence_name != null && SERIAL_TYPES.has(String(row.type))
    const locked = identity || generated || serial
    return {
      id: String(row.name),
      name: String(row.name),
      type: String(row.type),
      nullable: row.nullable === true,
      defaultValue: row.default_expr == null ? null : String(row.default_expr),
      description: row.description == null ? null : String(row.description),
      pk: pkCols.has(String(row.name)),
      fks: fksByColumn.get(String(row.name)),
      uks: uksByColumn.get(String(row.name)),
      locked,
      lockKind: identity ? 'identity' : generated ? 'generated' : serial ? 'serial' : undefined,
    }
  })
  const state: Omit<TableEditState, 'fingerprint'> = {
    oid: String(oid),
    schema: String(table.schema),
    name: String(table.name),
    relkind: relkind as 'r' | 'p',
    description: table.description == null ? null : String(table.description),
    columns,
  }
  return { ...state, fingerprint: stateFingerprint(state) }
}

function validationError(message: string): never {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 400
  throw err
}

function conflict(message: string): never {
  const err = new Error(message)
  ;(err as Error & { statusCode: number }).statusCode = 409
  throw err
}

/** Validate a submitted dialog against the freshly read live table. */
function validateRequest(live: LiveTable, request: TableEditRequest): void {
  if (live.relkind !== 'r' && live.relkind !== 'p') {
    validationError('Only ordinary and partitioned tables can be edited')
  }
  if (request.columns.length > 1000) validationError('Too many columns')
  const seenIds = new Set<string>()
  for (const col of request.columns) {
    if (typeof col.id !== 'string' || !col.id) validationError('Column identity is missing')
    if (seenIds.has(col.id)) validationError(`Duplicate column "${col.id}"`)
    seenIds.add(col.id)
    if (typeof col.name !== 'string' || typeof col.type !== 'string' || typeof col.nullable !== 'boolean') {
      validationError('Invalid column row')
    }
    if (col.name.length > 255 || col.type.length > 2000) validationError('Column row too long')
  }
}

function liveView(state: TableEditState): LiveTable {
  return {
    relkind: state.relkind,
    schema: state.schema,
    name: state.name,
    description: state.description,
    columns: state.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      description: c.description,
      pk: c.pk,
      locked: c.locked,
      lockKind: c.lockKind,
    })),
  }
}

/** Generate the change-only ALTER script for a submitted dialog, or null when
 * nothing differs. The live catalog is re-read as the source of truth, and the
 * submitted fingerprint must match it so a table changed since the dialog
 * loaded is rejected instead of diffed against a stale column set. */
export async function tableEditDdl(
  pool: Pool,
  oid: string,
  request: TableEditRequest,
): Promise<string | null> {
  const state = await fetchTableEditState(pool, oid)
  if (request.fingerprint !== state.fingerprint) {
    conflict('This table changed on the server since the editor loaded — close and reopen it')
  }
  const live = liveView(state)
  validateRequest(live, request)
  const outcome = diffTableEdit(live, request)
  if (outcome.kind === 'error') {
    const e = outcome.error
    const message =
      e.kind === 'locked'
        ? `Column "${e.column}" is an identity/generated/serial column — its type, default and nullability cannot be changed here`
        : e.kind === 'pk-drop'
          ? `Column "${e.column}" is part of the primary key and cannot be dropped`
          : e.kind === 'pk-nullable'
            ? `Column "${e.column}" is part of the primary key and must remain NOT NULL`
            : e.kind === 'unknown-column'
              ? `Column "${e.id}" no longer matches the table — please reload`
              : e.kind === 'duplicate'
                ? `Column name "${e.column}" is used more than once`
                : e.kind === 'empty-name'
                  ? 'Every column needs a name'
                  : `Column "${e.column}" needs a type`
    validationError(message)
  }
  if (!outcome.statements.length) return null
  return outcome.statements.map((s) => `${s};`).join('\n\n') + '\n'
}
