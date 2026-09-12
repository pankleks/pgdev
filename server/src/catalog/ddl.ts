import type { Pool } from 'pg'

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function serialType(type: string): string | null {
  if (type === 'smallint') return 'smallserial'
  if (type === 'integer') return 'serial'
  if (type === 'bigint') return 'bigserial'
  return null
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

  const [colsRes, consRes, idxRes, pkRes, relRes, policiesRes, foreignRes] = await Promise.all([
    pool.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull,
         a.attidentity AS identity,
         a.attgenerated AS generated,
         pg_get_expr(d.adbin, d.adrelid) AS default_value,
         pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS sequence_name,
         quote_literal(col_description(a.attrelid, a.attnum)) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [relOid],
    ),
    pool.query(
      // A foreign key pointing at a partitioned table is stored once per
      // partition. Rewrite those to name the partitioned parent, in the usual
      // clause order, so the duplicate rows collapse and the DDL never
      // references a partition (which does not exist yet at that point).
      `SELECT conname, contype, CASE
         WHEN contype = 'f' THEN
           'FOREIGN KEY (' ||
             (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           || ') REFERENCES ' || format('%I.%I', COALESCE(pcn.nspname, rcn.nspname),
                                         COALESCE(pc.relname, rc.relname)) || ' (' ||
             (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)
           || ')'
           || CASE con.confdeltype WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
                WHEN 'n' THEN ' ON DELETE SET NULL' WHEN 'd' THEN ' ON DELETE SET DEFAULT' ELSE '' END
           || CASE con.confupdtype WHEN 'r' THEN ' ON UPDATE RESTRICT' WHEN 'c' THEN ' ON UPDATE CASCADE'
                WHEN 'n' THEN ' ON UPDATE SET NULL' WHEN 'd' THEN ' ON UPDATE SET DEFAULT' ELSE '' END
           || CASE WHEN con.condeferrable THEN ' DEFERRABLE' ELSE '' END
           || CASE WHEN con.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END
         ELSE pg_get_constraintdef(con.oid)
       END AS def
       FROM pg_constraint con
       -- A foreign key to a partitioned table is stored once per partition
       -- (confrelid = the partition, whose relkind is 'r'). Walk up the
       -- inheritance chain so every copy is attributed to the same
       -- partitioned ancestor; identical definitions then collapse.
       LEFT JOIN pg_class rc ON rc.oid = con.confrelid
       LEFT JOIN pg_inherits inh ON inh.inhrelid = rc.oid
       LEFT JOIN pg_class pc ON pc.oid = inh.inhparent AND pc.relkind = 'p'
       LEFT JOIN pg_namespace pcn ON pcn.oid = pc.relnamespace
       LEFT JOIN pg_namespace rcn ON rcn.oid = rc.relnamespace
       WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x')
       ORDER BY con.contype, conname`,
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
    pool.query(
      `SELECT c.relkind, c.relpersistence, c.relispartition,
         c.relrowsecurity, c.relforcerowsecurity,
         pg_get_userbyid(c.relowner) AS owner,
         (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace) AS tablespace,
         quote_literal(obj_description(c.oid)) AS comment,
         (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid = c.oid) AS partkey,
         pn.nspname AS part_schema, p.relname AS part_name,
         CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partbound
       FROM pg_class c
       LEFT JOIN pg_inherits i ON i.inhrelid = c.oid AND c.relispartition
       LEFT JOIN pg_class p ON p.oid = i.inhparent
       LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace
       WHERE c.oid = $1`,
      [relOid],
    ),
    pool.query(
      `SELECT polname, polcmd, NOT polpermissive AS restrictive,
          (SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
           FROM pg_roles r WHERE r.oid = ANY (p.polroles)) AS roles,
         pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
       FROM pg_policy p
       WHERE p.polrelid = $1
       ORDER BY p.polname`,
      [relOid],
    ),
    pool.query(
      `SELECT s.srvname AS server
       FROM pg_foreign_table ft
       JOIN pg_foreign_server s ON s.oid = ft.ftserver
       WHERE ft.ftrelid = $1`,
      [relOid],
    ),
  ])

  const rel = relRes.rows[0]
  if (!rel) notFound()
  const table = `${ident(schema)}.${ident(name)}`
  const chunks: string[] = []

  if (rel.relispartition && rel.part_name) {
    // Partitions inherit columns/constraints/indexes from the parent —
    // only the attachment bound is per-partition DDL.
    const bound = String(rel.partbound ?? '').trim()
    // pg_get_expr returns bounds in their final form: list/range bounds read
    // "FOR VALUES …", a default partition reads "DEFAULT" (which must NOT be
    // prefixed with FOR VALUES). Only hash bounds need the wrapper.
    const partitionBound = /^(FOR\s+VALUES|DEFAULT)\b/i.test(bound) ? bound : `FOR VALUES ${bound}`
    chunks.push(
      `CREATE TABLE ${table}\n  PARTITION OF ${ident(rel.part_schema)}.${ident(rel.part_name)}\n  ${partitionBound};`,
    )
  } else {
    const pkCols = new Set(pkRes.rows.map((r) => r.attname as string))
    const lines = colsRes.rows.map((r) => {
      const serial = !r.identity && !r.generated && r.sequence_name ? serialType(r.type) : null
      const parts = [`${ident(r.name)} ${serial ?? r.type}`]
      if (r.generated === 's' && r.default_value != null) {
        parts.push(`GENERATED ALWAYS AS (${r.default_value}) STORED`)
      } else if (r.identity === 'a') {
        parts.push('GENERATED ALWAYS AS IDENTITY')
      } else if (r.identity === 'd') {
        parts.push('GENERATED BY DEFAULT AS IDENTITY')
      } else if (!serial && r.default_value != null) {
        parts.push(`DEFAULT ${r.default_value}`)
      }
      if (r.notnull && !pkCols.has(r.name)) parts.push('NOT NULL')
      return `  ${parts.join(' ')}`
    })

    // A foreign key that references a partitioned table is stored once per
    // partition, so the catalogue returns several rows with identical
    // definitions (…_fkey, …_fkey1, …_fkey2). Emitting each as an inline
    // CONSTRAINT makes the names collide, so collapse identical definitions.
    const constraintNames = new Set(consRes.rows.map((r) => r.conname as string))
    const seenDefs = new Set<string>()
    for (const c of consRes.rows) {
      const def = String(c.def)
      if (seenDefs.has(def)) continue
      seenDefs.add(def)
      lines.push(`  CONSTRAINT ${ident(c.conname)} ${def}`)
    }

    const kind = rel.relkind === 'f' ? 'FOREIGN TABLE' : rel.relpersistence === 'u' ? 'UNLOGGED TABLE' : 'TABLE'
    let create = `CREATE ${kind} ${table} (\n${lines.join(',\n')}\n)`
    if (rel.relkind === 'f' && foreignRes.rows[0]) {
      create += `\n  SERVER ${ident(foreignRes.rows[0].server)}`
    }
    if (rel.partkey) create += `\n  PARTITION BY ${rel.partkey}`
    if (rel.tablespace) create += `\n  TABLESPACE ${ident(rel.tablespace)}`
    chunks.push(create + ';')

    if (!rel.relispartition) {
      const extraIndexes = idxRes.rows.filter((r) => !constraintNames.has(r.indexname))
      if (extraIndexes.length) {
        chunks.push(extraIndexes.map((r) => `${r.indexdef};`).join('\n'))
      }
    }
  }

  if (rel.relrowsecurity || rel.relforcerowsecurity) chunks.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)
  if (rel.relforcerowsecurity) chunks.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`)
  const cmdName: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }
  for (const p of policiesRes.rows) {
    const forWhat = `FOR ${cmdName[p.polcmd as string] ?? 'ALL'}`
    const toRoles = `TO ${p.roles ?? 'PUBLIC'}`
    const asMode = p.restrictive ? ' AS RESTRICTIVE' : ''
    const using = p.qual != null ? ` USING (${p.qual})` : ''
    const check = p.withcheck != null ? ` WITH CHECK (${p.withcheck})` : ''
    chunks.push(
      `CREATE POLICY ${ident(p.polname)} ON ${table}${asMode}\n  ${forWhat} ${toRoles}${using}${check};`,
    )
  }

  if (rel.owner) chunks.push(`ALTER TABLE ${table} OWNER TO ${ident(rel.owner)};`)
  if (rel.comment) chunks.push(`COMMENT ON TABLE ${table} IS ${rel.comment};`)
  for (const c of colsRes.rows) {
    if (c.comment) {
      chunks.push(`COMMENT ON COLUMN ${table}.${ident(c.name)} IS ${c.comment};`)
    }
  }
  return chunks.join('\n\n')
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
       ORDER BY pg_get_function_identity_arguments(p.oid), p.oid
       LIMIT 1`,
      [schema, name],
    )
    if (!fallback.rows[0]) notFound()
    target = fallback.rows[0].oid
  }
  const info = await pool.query(
    `SELECT p.prokind, n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.oid = $1::oid`,
    [target],
  )
  const row = info.rows[0]
  if (!row) notFound()
  const q = `${ident(row.schema)}.${ident(row.name)}(${row.args})`
  if (row.prokind === 'a') return aggregateDdl(pool, target, q)
  // NB: pg_get_functiondef() only works for plain/window functions and
  // procedures — aggregates are handled above.
  const res = await pool.query(`SELECT pg_get_functiondef($1::oid) AS def`, [target])
  if (!res.rows[0]) notFound()
  const def = String(res.rows[0].def).trim()
  const ddl = def.endsWith(';') ? def : def + ';'
  const keyword = row.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION'
  const drop = `-- DROP ${keyword} IF EXISTS ${q};`
  return `${drop}\n\n${ddl}`
}

async function aggregateDdl(pool: Pool, oid: string, q: string): Promise<string> {
  const res = await pool.query(
    `SELECT a.aggkind, a.aggtransfn::regproc::text AS sfunc,
            format_type(a.aggtranstype, NULL) AS stype,
            NULLIF(a.aggfinalfn::regproc::text, '-') AS finalfn,
            NULLIF(a.aggcombinefn::regproc::text, '-') AS combinefn,
            NULLIF(a.aggserialfn::regproc::text, '-') AS serialfn,
            NULLIF(a.aggdeserialfn::regproc::text, '-') AS deserialfn,
            NULLIF(a.agginitval, '') AS initcond,
            -- aggsortop is a plain oid and regoper renders 0 as "0" (only
            -- regproc/regclass render "-"), so zero it out explicitly.
            NULLIF(a.aggsortop, 0)::regoper::text AS sortop,
            p.proparallel
     FROM pg_aggregate a
     JOIN pg_proc p ON p.oid = a.aggfnoid
     WHERE a.aggfnoid = $1::oid`,
    [oid],
  )
  const row = res.rows[0]
  if (!row) notFound()
  const opts = [`SFUNC = ${row.sfunc}`, `STYPE = ${row.stype}`]
  if (row.finalfn) opts.push(`FINALFUNC = ${row.finalfn}`)
  if (row.combinefn) opts.push(`COMBINEFUNC = ${row.combinefn}`)
  if (row.serialfn) opts.push(`SERIALFUNC = ${row.serialfn}`)
  if (row.deserialfn) opts.push(`DESERIALFUNC = ${row.deserialfn}`)
  if (row.initcond != null) opts.push(`INITCOND = '${String(row.initcond).replace(/'/g, "''")}'`)
  if (row.sortop) opts.push(`SORTOP = OPERATOR(${row.sortop})`)
  if (row.proparallel === 's') opts.push('PARALLEL = SAFE')
  else if (row.proparallel === 'r') opts.push('PARALLEL = RESTRICTED')
  const header =
    row.aggkind === 'n'
      ? `CREATE AGGREGATE ${q} (`
      : `-- NOTE: ordered-set/hypothetical aggregate — verify the ORDER BY direct-argument list.\nCREATE AGGREGATE ${q} (`
  const ddl = `${header}\n  ${opts.join(',\n  ')}\n);`
  const drop = `-- DROP AGGREGATE IF EXISTS ${q};`
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
  const def = String(res.rows[0].def).trim() + ';'
  const drop = `-- DROP INDEX IF EXISTS ${ident(schema)}.${ident(name)};`
  return `${drop}\n\n${def}`
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
  const def = `ALTER TABLE ${ident(schema)}.${ident(table)}\n  ADD CONSTRAINT ${ident(name)} ${String(res.rows[0].def).trim()};`
  const drop = `-- ALTER TABLE ${ident(schema)}.${ident(table)} DROP CONSTRAINT ${ident(name)};`
  return `${drop}\n\n${def}`
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
  const def = String(res.rows[0].def).trim() + ';'
  const drop = `-- DROP TRIGGER IF EXISTS ${ident(name)} ON ${ident(schema)}.${ident(table)};`
  return `${drop}\n\n${def}`
}

export async function typeDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  let target = oid
  if (!target) {
    const fallback = await pool.query(
      `SELECT t.oid::text AS oid
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = $2
       LIMIT 1`,
      [schema, name],
    )
    if (!fallback.rows[0]) notFound()
    target = fallback.rows[0].oid
  }
  const res = await pool.query(
    `SELECT t.typtype, t.typnotnull, t.typdefault,
       format_type(t.typbasetype, t.typtypmod) AS base,
       (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
        (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
          FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs,
       (SELECT string_agg(pg_get_constraintdef(c.oid), ' ' ORDER BY c.oid)
          FROM pg_constraint c WHERE c.contypid = t.oid) AS cons,
       format_type(r.rngsubtype, NULL) AS subtype,
       -- rngsubopc is a plain oid, not a regclass: casting it straight to
       -- ::regclass::text renders the numeric oid, which SUBTYPE_OPCLASS
       -- rejects. Resolve the name from pg_opclass instead.
       (SELECT quote_ident(ocn.nspname) || '.' || quote_ident(oc.opcname)
          FROM pg_opclass oc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace
          WHERE oc.oid = r.rngsubopc) AS subopc,
       -- regproc/regclass render oid 0 as "-", not NULL, so NULLIF it away
       -- here: a truthiness check downstream would otherwise emit
       -- "CANONICAL = -", which no CREATE TYPE can accept.
       NULLIF(r.rngcanonical, 0)::regproc::text AS canonical,
       NULLIF(r.rngsubdiff, 0)::regproc::text AS subdiff
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     LEFT JOIN pg_range r ON r.rngtypid = t.oid
     WHERE t.oid = $1::oid`,
    [target],
  )
  const row = res.rows[0]
  if (!row) notFound()
  const q = `${ident(schema)}.${ident(name)}`
  let ddl: string
  if (row.typtype === 'e') {
    ddl = `CREATE TYPE ${q} AS ENUM (${row.labels ?? ''});`
  } else if (row.typtype === 'c') {
    ddl = `CREATE TYPE ${q} AS (${row.attrs ?? ''});`
  } else if (row.typtype === 'd') {
    const parts = [`CREATE DOMAIN ${q} AS ${row.base}`]
    if (row.typdefault != null) parts.push(`DEFAULT ${row.typdefault}`)
    if (row.typnotnull) parts.push('NOT NULL')
    if (row.cons) parts.push(String(row.cons).trim())
    ddl = parts.join(' ') + ';'
  } else if (row.typtype === 'r') {
    const opts = [`SUBTYPE = ${row.subtype}`]
    if (row.subopc) opts.push(`SUBTYPE_OPCLASS = ${row.subopc}`)
    if (row.canonical && row.canonical !== '-') opts.push(`CANONICAL = ${row.canonical}`)
    if (row.subdiff && row.subdiff !== '-') opts.push(`SUBTYPE_DIFF = ${row.subdiff}`)
    ddl = `CREATE TYPE ${q} AS RANGE (\n  ${opts.join(',\n  ')}\n);`
  } else {
    notFound()
  }
  const drop = row.typtype === 'd' ? `-- DROP DOMAIN IF EXISTS ${q};` : `-- DROP TYPE IF EXISTS ${q};`
  return `${drop}\n\n${ddl}`
}
