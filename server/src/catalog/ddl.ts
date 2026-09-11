import type { Pool } from 'pg'

function ident(s: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`
}

function notFound(): never {
  const err = new Error('Object not found')
  ;(err as Error & { statusCode: number }).statusCode = 404
  throw err
}

async function resolveOid(pool: Pool, schema: string, name: string): Promise<string> {
  const res = await pool.query(
    `SELECT c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  )
  if (!res.rows[0]) notFound()
  return res.rows[0].oid
}

export async function tableDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  const relOid = oid || (await resolveOid(pool, schema, name))

  const [colsRes, consRes, idxRes, pkRes] = await Promise.all([
    pool.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull,
         pg_get_expr(d.adbin, d.adrelid) AS default_value
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [relOid],
    ),
    pool.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c')
       ORDER BY contype, conname`,
      [relOid],
    ),
    pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2
       ORDER BY indexname`,
      [schema, name],
    ),
    pool.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = $1 AND i.indisprimary`,
      [relOid],
    ),
  ])

  const pkCols = new Set(pkRes.rows.map((r) => r.attname as string))
  const lines = colsRes.rows.map((r) => {
    const parts = [`${ident(r.name)} ${r.type}`]
    if (r.default_value != null) parts.push(`DEFAULT ${r.default_value}`)
    if (r.notnull && !pkCols.has(r.name)) parts.push('NOT NULL')
    return `  ${parts.join(' ')}`
  })

  const constraintNames = new Set(consRes.rows.map((r) => r.conname as string))
  for (const c of consRes.rows) {
    lines.push(`  CONSTRAINT ${ident(c.conname)} ${c.def}`)
  }

  const table = `${ident(schema)}.${ident(name)}`
  let ddl = `CREATE TABLE ${table} (\n${lines.join(',\n')}\n);`

  const extraIndexes = idxRes.rows.filter((r) => !constraintNames.has(r.indexname))
  if (extraIndexes.length) {
    ddl += '\n\n' + extraIndexes.map((r) => `${r.indexdef};`).join('\n')
  }
  return ddl
}

export async function viewDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  const relOid = oid || (await resolveOid(pool, schema, name))
  const res = await pool.query(
    `SELECT c.relkind, pg_get_viewdef(c.oid, true) AS def FROM pg_class c WHERE c.oid = $1`,
    [relOid],
  )
  const row = res.rows[0]
  if (!row) notFound()
  const materialized = row.relkind === 'm'
  const keyword = materialized ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
  const definition = String(row.def).trim().replace(/;$/, '')
  const drop = `-- DROP ${materialized ? 'MATERIALIZED ' : ''}VIEW IF EXISTS ${ident(schema)}.${ident(name)};`
  return `${drop}\n\n${keyword} ${ident(schema)}.${ident(name)} AS\n${definition};`
}

export async function functionDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  let target = oid
  if (!target) {
    const fallback = await pool.query(
      `SELECT p.oid::text AS oid
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2
       ORDER BY p.oid
       LIMIT 1`,
      [schema, name],
    )
    if (!fallback.rows[0]) notFound()
    target = fallback.rows[0].oid
  }
  const res = await pool.query(
    `SELECT pg_get_functiondef(p.oid) AS def,
            n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.oid = $1::oid`,
    [target],
  )
  const row = res.rows[0]
  if (!row) notFound()
  const def = String(row.def).trim()
  const ddl = def.endsWith(';') ? def : def + ';'
  const drop = `-- DROP FUNCTION IF EXISTS ${ident(row.schema)}.${ident(row.name)}(${row.args});`
  return `${drop}\n\n${ddl}`
}

export async function indexDdl(pool: Pool, schema: string, name: string): Promise<string> {
  const res = await pool.query(
    `SELECT pg_get_indexdef(ic.oid) AS def
     FROM pg_class ic JOIN pg_namespace n ON n.oid = ic.relnamespace
     WHERE n.nspname = $1 AND ic.relname = $2`,
    [schema, name],
  )
  if (!res.rows[0]) notFound()
  return String(res.rows[0].def).trim() + ';'
}

export async function constraintDdl(pool: Pool, schema: string, table: string, name: string): Promise<string> {
  const res = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3`,
    [schema, table, name],
  )
  if (!res.rows[0]) notFound()
  return `ALTER TABLE ${ident(schema)}.${ident(table)}\n  ADD CONSTRAINT ${ident(name)} ${String(res.rows[0].def).trim()};`
}

export async function triggerDdl(pool: Pool, schema: string, table: string, name: string): Promise<string> {
  const res = await pool.query(
    `SELECT pg_get_triggerdef(t.oid) AS def
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`,
    [schema, table, name],
  )
  if (!res.rows[0]) notFound()
  return String(res.rows[0].def).trim() + ';'
}
