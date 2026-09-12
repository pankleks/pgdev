import type { Pool } from 'pg'

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
}

export interface IndexInfo {
  name: string
  type: 'primary' | 'unique' | 'exclusion' | 'normal'
  method: string
}

export interface ConstraintInfo {
  name: string
  type: string
  definition: string
}

export interface TriggerInfo {
  name: string
  definition: string
}

export interface TableInfo {
  schema: string
  name: string
  oid: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  constraints: ConstraintInfo[]
  triggers: TriggerInfo[]
  isPartition: boolean
  isPartitioned: boolean
  parents: string
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
  kind: 'function' | 'procedure' | 'window' | 'trigger' | 'aggregate'
  oid: string
}

export interface TypeInfo {
  schema: string
  name: string
  oid: string
  kind: 'enum' | 'composite' | 'domain' | 'range'
  detail: string
}

export interface SchemaData {
  tables: TableInfo[]
  views: ViewInfo[]
  functions: FunctionInfo[]
  types: TypeInfo[]
}

const TABLES_SQL = `
SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid,
  c.relispartition AS is_partition,
  c.relkind = 'p' AS is_partitioned,
  COALESCE((SELECT string_agg(pn.nspname || '.' || pc.relname, ', ')
    FROM pg_inherits i
    JOIN pg_class pc ON pc.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE i.inhrelid = c.oid), '') AS parents
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

const INDEXES_SQL = `
SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name,
  CASE
    WHEN i.indisprimary THEN 'primary'
    WHEN i.indisexclusion THEN 'exclusion'
    WHEN i.indisunique THEN 'unique'
    ELSE 'normal'
  END AS type,
  am.amname AS method
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_am am ON am.oid = ic.relam
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, ic.relname`

const CONSTRAINTS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, con.conname`

const TRIGGERS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
  pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, t.tgname`

const FUNCTIONS_SQL = `
SELECT n.nspname AS schema, p.proname AS name,
  COALESCE(pg_get_function_identity_arguments(p.oid), '') AS args,
  pg_get_function_result(p.oid) AS returns,
  COALESCE((SELECT string_agg(format_type(t.oid, NULL), ', ') FROM unnest(p.proargtypes) AS t(oid)), '') AS type_sig,
  CASE
    WHEN pg_get_function_result(p.oid) = 'trigger' THEN 'trigger'
    WHEN p.prokind = 'p' THEN 'procedure'
    WHEN p.prokind = 'w' THEN 'window'
    WHEN p.prokind = 'a' THEN 'aggregate'
    ELSE 'function'
  END AS kind,
  p.oid::text AS oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prokind IN ('f', 'p', 'w', 'a')
ORDER BY n.nspname, p.proname`

const TYPES_SQL = `
SELECT n.nspname AS schema, t.typname AS name, t.oid::text AS oid,
  CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' WHEN 'd' THEN 'domain' ELSE 'range' END AS kind,
  COALESCE(en.labels, ca.attrs, dm.base, format_type(r.rngsubtype, NULL), '') AS detail
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN LATERAL (
  SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
  FROM pg_enum e WHERE e.enumtypid = t.oid
) en ON t.typtype = 'e'
LEFT JOIN LATERAL (
  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) AS attrs
  FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
) ca ON t.typtype = 'c'
LEFT JOIN LATERAL (
  SELECT format_type(t.typbasetype, t.typtypmod) AS base
) dm ON t.typtype = 'd'
LEFT JOIN pg_range r ON r.rngtypid = t.oid
WHERE t.typtype IN ('e', 'c', 'd', 'r')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_class c WHERE c.oid = t.typrelid))
ORDER BY n.nspname, t.typname`

export async function fetchSchemaData(pool: Pool): Promise<SchemaData> {
  const [tablesRes, viewsRes, columnsRes, functionsRes, typesRes, indexesRes, constraintsRes, triggersRes] =
    await Promise.all([
      pool.query(TABLES_SQL),
      pool.query(VIEWS_SQL),
      pool.query(COLUMNS_SQL),
      pool.query(FUNCTIONS_SQL),
      pool.query(TYPES_SQL),
      pool.query(INDEXES_SQL),
      pool.query(CONSTRAINTS_SQL),
      pool.query(TRIGGERS_SQL),
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

  const indexesByRel = new Map<string, IndexInfo[]>()
  for (const row of indexesRes.rows) {
    const key = `${row.schema}\u0000${row.table}`
    let list = indexesByRel.get(key)
    if (!list) {
      list = []
      indexesByRel.set(key, list)
    }
    list.push({ name: row.name, type: row.type, method: row.method })
  }

  const constraintsByRel = new Map<string, ConstraintInfo[]>()
  for (const row of constraintsRes.rows) {
    const key = `${row.schema}\u0000${row.table}`
    let list = constraintsByRel.get(key)
    if (!list) {
      list = []
      constraintsByRel.set(key, list)
    }
    list.push({ name: row.name, type: row.type, definition: row.definition })
  }

  const triggersByRel = new Map<string, TriggerInfo[]>()
  for (const row of triggersRes.rows) {
    const key = `${row.schema}\u0000${row.table}`
    let list = triggersByRel.get(key)
    if (!list) {
      list = []
      triggersByRel.set(key, list)
    }
    list.push({ name: row.name, definition: row.definition })
  }

  const relKey = (schema: string, name: string) => `${schema}\u0000${name}`

  const tables: TableInfo[] = tablesRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    oid: r.oid,
    columns: columnsByRel.get(relKey(r.schema, r.name)) ?? [],
    indexes: indexesByRel.get(relKey(r.schema, r.name)) ?? [],
    constraints: constraintsByRel.get(relKey(r.schema, r.name)) ?? [],
    triggers: triggersByRel.get(relKey(r.schema, r.name)) ?? [],
    isPartition: r.is_partition,
    isPartitioned: r.is_partitioned,
    parents: r.parents,
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
    kind: r.kind,
    oid: r.oid,
  }))

  const types: TypeInfo[] = typesRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    oid: r.oid,
    kind: r.kind,
    detail: r.detail ?? '',
  }))

  return { tables, views, functions, types }
}
