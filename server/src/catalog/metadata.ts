import type { Pool } from 'pg'

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
}

export interface TableInfo {
  schema: string
  name: string
  oid: string
  columns: ColumnInfo[]
}

export interface ViewInfo {
  schema: string
  name: string
  oid: string
  materialized: boolean
  columns: ColumnInfo[]
}

export interface FunctionInfo {
  schema: string
  name: string
  args: string
  returns: string
  typeSig: string
  oid: string
}

export interface SchemaData {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: FunctionInfo[]
}

const TABLES_SQL = `
SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname`

const VIEWS_SQL = `
SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid, c.relkind = 'm' AS materialized
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname`

const COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS rel, a.attname AS name,
  format_type(a.atttypid, a.atttypmod) AS type,
  NOT a.attnotnull AS nullable,
  pg_get_expr(d.adbin, d.adrelid) AS default_value
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, a.attnum`

const FUNCTIONS_SQL = `
SELECT n.nspname AS schema, p.proname AS name,
  COALESCE(pg_get_function_identity_arguments(p.oid), '') AS args,
  pg_get_function_result(p.oid) AS returns,
  COALESCE((SELECT string_agg(format_type(t.oid, NULL), ', ') FROM unnest(p.proargtypes) AS t(oid)), '') AS type_sig,
  p.oid::text AS oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prokind IN ('f', 'p', 'w')
ORDER BY n.nspname, p.proname`

export async function fetchSchemaData(pool: Pool): Promise<SchemaData> {
  const [tablesRes, viewsRes, columnsRes, functionsRes] = await Promise.all([
    pool.query(TABLES_SQL),
    pool.query(VIEWS_SQL),
    pool.query(COLUMNS_SQL),
    pool.query(FUNCTIONS_SQL),
  ])

  const columnsByRel = new Map<string, ColumnInfo[]>()
  for (const row of columnsRes.rows) {
    const key = `${row.schema}\u0000${row.rel}`
    let list = columnsByRel.get(key)
    if (!list) {
      list = []
      columnsByRel.set(key, list)
    }
    list.push({
      name: row.name,
      type: row.type,
      nullable: row.nullable,
      defaultValue: row.default_value ?? null,
    })
  }

  const tables: TableInfo[] = tablesRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    oid: r.oid,
    columns: columnsByRel.get(`${r.schema}\u0000${r.name}`) ?? [],
  }))

  const views: ViewInfo[] = viewsRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    oid: r.oid,
    materialized: r.materialized,
    columns: columnsByRel.get(`${r.schema}\u0000${r.name}`) ?? [],
  }))

  const functions: FunctionInfo[] = functionsRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    args: r.args,
    returns: r.returns,
    typeSig: r.type_sig,
    oid: r.oid,
  }))

  return { tables, views, functions }
}
