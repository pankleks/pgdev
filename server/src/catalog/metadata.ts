import type { Pool } from 'pg'
import type {
  ColumnInfo,
  ConstraintInfo,
  FunctionInfo,
  IndexInfo,
  SchemaData,
  TableInfo,
  TriggerInfo,
  TypeInfo,
  ViewInfo,
} from '../schema-types.js'

// Schemas the browser never shows: system catalogs, TOAST, and other
// sessions' temporary tables. Interpolated into every catalog query so the
// rules cannot drift apart.
const USER_SCHEMA_SQL = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'`

const TABLES_SQL = `
SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid,
  c.relispartition AS is_partition,
  c.relkind = 'p' AS is_partitioned,
  c.relkind::text AS relkind,
  COALESCE((SELECT string_agg(pn.nspname || '.' || pc.relname, ', ')
    FROM pg_inherits i
    JOIN pg_class pc ON pc.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE i.inhrelid = c.oid), '') AS parents
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'f')
  AND ${USER_SCHEMA_SQL}
ORDER BY n.nspname, c.relname`

const VIEWS_SQL = `
SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid, c.relkind = 'm' AS materialized
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm')
  AND ${USER_SCHEMA_SQL}
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
  AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
  AND ${USER_SCHEMA_SQL}
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
WHERE ${USER_SCHEMA_SQL}
ORDER BY n.nspname, c.relname, ic.relname`

const CONSTRAINTS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE ${USER_SCHEMA_SQL}
ORDER BY n.nspname, c.relname, con.conname`

const TRIGGERS_SQL = `
SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
  pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND ${USER_SCHEMA_SQL}
ORDER BY n.nspname, c.relname, t.tgname`

const FUNCTIONS_SQL = `
SELECT n.nspname AS schema, p.proname AS name,
  COALESCE(pg_get_function_identity_arguments(p.oid), '') AS args,
  -- Procedures have no result type; COALESCE keeps the JSON contract string.
  COALESCE(pg_get_function_result(p.oid), '') AS returns,
  COALESCE((SELECT string_agg(format_type(t.oid, NULL), ', ') FROM unnest(p.proargtypes) AS t(oid)), '') AS type_sig,
  -- Named arguments and defaults are for hover/completion only; DDL keeps the
  -- identity form above.
  COALESCE(pg_get_function_arguments(p.oid), '') AS arguments,
  obj_description(p.oid, 'pg_proc') AS comment,
  CASE
    -- prorettype rather than a second pg_get_function_result call: a
    -- trigger function is exactly one whose return type is trigger.
    WHEN p.prorettype = 'trigger'::regtype THEN 'trigger'
    WHEN p.prokind = 'p' THEN 'procedure'
    WHEN p.prokind = 'w' THEN 'window'
    WHEN p.prokind = 'a' THEN 'aggregate'
    ELSE 'function'
  END AS kind,
  p.oid::text AS oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p', 'w', 'a')
  AND ${USER_SCHEMA_SQL}
ORDER BY n.nspname, p.proname, p.oid`

// Built-in functions for completion: SQL-callable pg_catalog functions only.
// `pg_`-prefixed helpers, and anything taking or returning an internal type,
// are C-level machinery that no one types; `void` results (setseed and other
// side-effect helpers) add noise without a call shape worth completing.
const BUILTINS_SQL = `
SELECT p.proname AS name,
  COALESCE(pg_get_function_identity_arguments(p.oid), '') AS args,
  COALESCE(pg_get_function_result(p.oid), '') AS returns,
  obj_description(p.oid, 'pg_proc') AS comment,
  CASE WHEN p.prokind = 'w' THEN 'window' WHEN p.prokind = 'a' THEN 'aggregate' ELSE 'function' END AS kind,
  p.oid::text AS oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'pg_catalog'
  AND p.prokind IN ('f', 'a', 'w')
  AND p.proname NOT LIKE 'pg\\_%'
  AND p.prorettype NOT IN (
    'internal'::regtype, 'cstring'::regtype, 'trigger'::regtype,
    'event_trigger'::regtype, 'void'::regtype
  )
  AND NOT EXISTS (
    SELECT 1 FROM unnest(p.proargtypes) t(oid)
    JOIN pg_type ty ON ty.oid = t.oid
    WHERE ty.typname IN ('internal', 'cstring', 'opaque', 'trigger', 'event_trigger', 'void', 'anynonarray')
  )
ORDER BY p.proname, p.oid`

// COALESCE, NULLIF, GREATEST and LEAST are grammar constructs rather than
// pg_proc entries, so BUILTINS_SQL never returns them; they are still written
// and called like functions and belong in completion and hover. The argument
// text mirrors the SQL syntax instead of a real identity signature.
const SPECIAL_FUNCTIONS: FunctionInfo[] = [
  {
    schema: 'pg_catalog',
    name: 'coalesce',
    args: 'value, ...',
    returns: 'any',
    typeSig: '',
    kind: 'function',
    oid: '',
    comment: 'returns the first of its arguments that is not null',
  },
  {
    schema: 'pg_catalog',
    name: 'nullif',
    args: 'value1, value2',
    returns: 'any',
    typeSig: '',
    kind: 'function',
    oid: '',
    comment: 'returns null when value1 equals value2, otherwise value1',
  },
  {
    schema: 'pg_catalog',
    name: 'greatest',
    args: 'value, ...',
    returns: 'any',
    typeSig: '',
    kind: 'function',
    oid: '',
    comment: 'returns the largest of its arguments',
  },
  {
    schema: 'pg_catalog',
    name: 'least',
    args: 'value, ...',
    returns: 'any',
    typeSig: '',
    kind: 'function',
    oid: '',
    comment: 'returns the smallest of its arguments',
  },
]

const TYPES_SQL = `SELECT n.nspname AS schema, t.typname AS name, t.oid::text AS oid,
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
  AND ${USER_SCHEMA_SQL}
  AND (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_class c WHERE c.oid = t.typrelid))
ORDER BY n.nspname, t.typname`

/** Group rows by an explicit key, projecting each row into the stored shape. */
function groupBy<Row, T>(
  rows: Row[],
  keyOf: (row: Row) => string,
  project: (row: Row) => T,
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = map.get(key)
    const item = project(row)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return map
}

export async function fetchSchemaData(pool: Pool): Promise<SchemaData> {
  const [tablesRes, viewsRes, columnsRes, functionsRes, typesRes, indexesRes, constraintsRes, triggersRes, builtinsRes] =
    await Promise.all([
      pool.query(TABLES_SQL),
      pool.query(VIEWS_SQL),
      pool.query(COLUMNS_SQL),
      pool.query(FUNCTIONS_SQL),
      pool.query(TYPES_SQL),
      pool.query(INDEXES_SQL),
      pool.query(CONSTRAINTS_SQL),
      pool.query(TRIGGERS_SQL),
      pool.query(BUILTINS_SQL),
    ])

  const relKey = (schema: string, name: string) => `${schema}\u0000${name}`

  const columnsByRel = groupBy(
    columnsRes.rows,
    (r) => relKey(r.schema, r.rel),
    (row) => ({
      name: row.name,
      type: row.type,
      nullable: row.nullable,
      defaultValue: row.default_value ?? null,
    }),
  )

  const indexesByRel = groupBy(
    indexesRes.rows,
    (r) => relKey(r.schema, r.table),
    (row) => ({ name: row.name, type: row.type, method: row.method }),
  )

  const constraintsByRel = groupBy(
    constraintsRes.rows,
    (r) => relKey(r.schema, r.table),
    (row) => ({ name: row.name, type: row.type, definition: row.definition }),
  )

  const triggersByRel = groupBy(
    triggersRes.rows,
    (r) => relKey(r.schema, r.table),
    (row) => ({ name: row.name, definition: row.definition }),
  )

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
    relkind: r.relkind,
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
    arguments: r.arguments ?? '',
    comment: r.comment ?? null,
  }))

  const types: TypeInfo[] = typesRes.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    oid: r.oid,
    kind: r.kind,
    detail: r.detail ?? '',
  }))

  const builtins: FunctionInfo[] = [
    ...builtinsRes.rows.map((r) => ({
      schema: 'pg_catalog',
      name: r.name,
      args: r.args,
      returns: r.returns,
      typeSig: '',
      kind: r.kind,
      oid: r.oid,
      comment: r.comment ?? null,
    })),
    // Grammar-level callables, appended after the catalog rows. The provider
    // prefix-filters this list, so the extra entries never flood the popup.
    ...SPECIAL_FUNCTIONS,
  ]

  return { tables, views, functions, types, builtins }
}
