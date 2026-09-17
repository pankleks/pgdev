import type { Pool } from 'pg'
import { ident } from '../sqlident.js'

function serialType(type: string): string | null {
  if (type === 'smallint') return 'smallserial'
  if (type === 'integer') return 'serial'
  if (type === 'bigint') return 'bigserial'
  return null
}

/** Per-type bounds of a sequence's underlying integer type. */
const SEQUENCE_BOUNDS: Record<string, { min: bigint; max: bigint }> = {
  smallint: { min: -32768n, max: 32767n },
  integer: { min: -2147483648n, max: 2147483647n },
  bigint: { min: -9223372036854775808n, max: 9223372036854775807n },
}

export interface SequenceProps {
  /** format_type output of the sequence's underlying type. */
  type: string
  /** pg_sequence values as stored (user terms, bigint as text). */
  start: string
  increment: string
  min: string
  max: string
  cache: string
  cycle: boolean
}

/**
 * The nondefault options of an owned sequence, in pg_dump's clause order.
 * Serial and identity columns always *create* ascending sequences, so an
 * option counts as default when it equals what a bare creation produces:
 * ascending start = MINVALUE (1 unless set), min 1, max = the type maximum;
 * descending max = -1, min = the type minimum, start = MAXVALUE.
 * `sequenceName` is the formatted `SEQUENCE NAME …` clause when the caller
 * carries a renamed/moved sequence (the serial shorthand cannot rename, so it
 * passes null). Unsupported types emit nothing.
 */
export function sequenceOptions(props: SequenceProps, sequenceName: string | null): string[] {
  const bounds = SEQUENCE_BOUNDS[props.type]
  if (!bounds) return []
  const min = BigInt(props.min)
  const max = BigInt(props.max)
  const start = BigInt(props.start)
  const increment = BigInt(props.increment)
  const cache = BigInt(props.cache)
  const ascending = increment > 0n
  const parts: string[] = []
  if (sequenceName) parts.push(sequenceName)
  if (ascending) {
    if (min !== 1n) parts.push(`MINVALUE ${min.toString()}`)
    if (max !== bounds.max) parts.push(`MAXVALUE ${max.toString()}`)
    if (start !== min) parts.push(`START WITH ${start.toString()}`)
  } else {
    if (min !== bounds.min) parts.push(`MINVALUE ${min.toString()}`)
    if (max !== -1n) parts.push(`MAXVALUE ${max.toString()}`)
    if (start !== max) parts.push(`START WITH ${start.toString()}`)
  }
  if (increment !== 1n) parts.push(`INCREMENT BY ${increment.toString()}`)
  if (cache !== 1n) parts.push(`CACHE ${cache.toString()}`)
  if (props.cycle) parts.push('CYCLE')
  return parts
}

/** A schema-qualified regclass reference as a SQL string literal — identifier
 * quoting via `ident()`, then single quotes doubled — for embedding in
 * `nextval('…'::regclass)` defaults, where identifier quoting alone would let
 * a single quote in the name terminate the literal. */
function regclassLiteral(schema: string, name: string): string {
  return `'${`${ident(schema)}.${ident(name)}`.replace(/'/g, "''")}'`
}

function notFound(): never {
  const err = new Error('Object not found')
  ;(err as Error & { statusCode: number }).statusCode = 404
  throw err
}

async function resolveOid(pool: Pool, schema: string, name: string, relkinds: string[]): Promise<string> {
  const res = await pool.query(
    `SELECT c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = ANY($3::text[])
     ORDER BY c.oid
     LIMIT 1`,
    [schema, name, relkinds],
  )
  if (!res.rows[0]) notFound()
  return res.rows[0].oid
}

export async function tableDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  const relOid = oid || (await resolveOid(pool, schema, name, ['r', 'p', 'f']))

  const [colsRes, consRes, idxRes, pkRes, relRes, policiesRes, foreignRes] = await Promise.all([
    pool.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull,
         a.attidentity AS identity,
         a.attgenerated AS generated,
         a.attinhcount AS inhcount,
         pg_get_expr(d.adbin, d.adrelid) AS default_value,
         -- The sequence owned by this column (serial or identity), with its
         -- properties, so nondefault options round-trip. pg_get_serial_
         -- sequence resolves the same dependency, but the pg_depend join
         -- keeps the lookup inside one query.
         seq.sequence_type, seq.sequence_start, seq.sequence_increment,
         seq.sequence_min, seq.sequence_max, seq.sequence_cache, seq.sequence_cycle,
         seq.owned_schema, seq.owned_name,
         -- format_type does not carry a collation, so reattach it explicitly
         -- (the default collation is implicit and can be omitted).
         CASE WHEN co.collname IS NOT NULL AND co.collname <> 'default'
              THEN ' COLLATE ' || quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
              ELSE '' END AS collation,
         (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || ' ' ||
                   quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord)
            FROM unnest(a.attfdwoptions) WITH ORDINALITY AS opt(o, ord)) AS fdw_options,
         quote_literal(col_description(a.attrelid, a.attnum)) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
       LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
       LEFT JOIN LATERAL (
         SELECT format_type(s.seqtypid, NULL) AS sequence_type,
                s.seqstart::text AS sequence_start,
                s.seqincrement::text AS sequence_increment,
                s.seqmin::text AS sequence_min,
                s.seqmax::text AS sequence_max,
                s.seqcache::text AS sequence_cache,
                s.seqcycle AS sequence_cycle,
                c2.relname AS owned_name, n2.nspname AS owned_schema
         FROM pg_depend dep
         JOIN pg_class c2 ON c2.oid = dep.objid AND c2.relkind = 'S'
         JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         JOIN pg_sequence s ON s.seqrelid = c2.oid
         WHERE dep.classid = 'pg_class'::regclass
           AND dep.refclassid = 'pg_class'::regclass
           AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum
           AND dep.deptype IN ('a', 'i')
       ) seq ON true
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [relOid],
    ),
    pool.query(
      // A foreign key pointing at a partition of a partitioned table is stored
      // once per partition. Those copies are rewritten to name the partitioned
      // parent, in the usual clause order, so the duplicate rows collapse and
      // the DDL never references a partition (which does not exist yet at that
      // point). Every other constraint — ordinary foreign keys included — comes
      // straight from pg_get_constraintdef, so MATCH, NOT VALID, deferred and
      // SET NULL/DEFAULT options all round-trip.
      `SELECT con.conname, con.contype,
         (con.contype = 'f' AND pc.oid IS NOT NULL) AS is_clone,
         CASE
           WHEN con.contype = 'f' AND pc.oid IS NOT NULL THEN
             'FOREIGN KEY (' ||
               (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
                  FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
             || ') REFERENCES ' || format('%I.%I', pcn.nspname, pc.relname) || ' (' ||
               (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
                  FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum)
             || ')'
             || CASE con.confmatchtype WHEN 'f' THEN ' MATCH FULL' WHEN 'p' THEN ' MATCH PARTIAL' ELSE '' END
             || CASE con.confdeltype WHEN 'r' THEN ' ON DELETE RESTRICT' WHEN 'c' THEN ' ON DELETE CASCADE'
                  WHEN 'n' THEN ' ON DELETE SET NULL' WHEN 'd' THEN ' ON DELETE SET DEFAULT' ELSE '' END
             || CASE con.confupdtype WHEN 'r' THEN ' ON UPDATE RESTRICT' WHEN 'c' THEN ' ON UPDATE CASCADE'
                  WHEN 'n' THEN ' ON UPDATE SET NULL' WHEN 'd' THEN ' ON UPDATE SET DEFAULT' ELSE '' END
             || CASE WHEN con.condeferrable THEN ' DEFERRABLE' ELSE '' END
             || CASE WHEN con.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END
             || CASE WHEN NOT con.convalidated THEN ' NOT VALID' ELSE '' END
           ELSE pg_get_constraintdef(con.oid)
         END AS def
       FROM pg_constraint con
       -- Walk up the inheritance chain so every per-partition copy of a
       -- foreign key referencing a partitioned table is attributed to the same
       -- partitioned ancestor; identical definitions then collapse.
       LEFT JOIN pg_class rc ON rc.oid = con.confrelid
       LEFT JOIN pg_inherits inh ON inh.inhrelid = rc.oid
       LEFT JOIN pg_class pc ON pc.oid = inh.inhparent AND pc.relkind = 'p'
       LEFT JOIN pg_namespace pcn ON pcn.oid = pc.relnamespace
       WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x')
         -- Constraints cloned from a partitioned parent (conparentid) or
         -- plain-inherited ones (coninhcount) are recreated automatically by
         -- the PARTITION OF / INHERITS clause — emitting them would collide.
         AND con.conparentid = 0 AND con.coninhcount = 0
       ORDER BY con.contype, conname`,
      [relOid],
    ),
    pool.query(
      // Indexes without a backing constraint: PRIMARY KEY / UNIQUE /
      // EXCLUDE indexes are emitted inline as CONSTRAINT clauses, so they
      // are matched by oid here rather than by name (an ALTER INDEX RENAME
      // must not turn a constraint into a duplicate standalone index).
      // Child indexes attached or cloned under a partitioned parent index
      // appear in pg_inherits and are recreated by the parent's CREATE INDEX.
      `SELECT idx.relname AS indexname, pg_get_indexdef(idx.oid) AS indexdef
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       LEFT JOIN pg_constraint con ON con.conindid = idx.oid
       WHERE i.indrelid = $1
         AND con.oid IS NULL
         AND NOT EXISTS (SELECT 1 FROM pg_inherits x WHERE x.inhrelid = idx.oid)
       ORDER BY idx.relname`,
      [relOid],
    ),
    pool.query(
      // pg_constraint.conkey lists only the key columns; pg_index.indkey also
      // carries INCLUDE columns, and treating a NOT NULL INCLUDE column as a
      // primary-key member would wrongly suppress its NOT NULL clause.
      `SELECT a.attname FROM pg_constraint con
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
       WHERE con.conrelid = $1 AND con.contype = 'p'`,
      [relOid],
    ),
    pool.query(
      `SELECT c.relkind, c.relpersistence, c.relispartition,
         c.relrowsecurity, c.relforcerowsecurity,
         n.nspname AS schema, c.relname AS name,
         pg_get_userbyid(c.relowner) AS owner,
         (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace) AS tablespace,
         quote_literal(obj_description(c.oid)) AS comment,
         (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid = c.oid) AS partkey,
         (SELECT pg_get_partkeydef(pp.partrelid) FROM pg_partitioned_table pp WHERE pp.partrelid = c.oid) AS own_partkey,
         -- Plain (non-partition) inheritance parents, for an INHERITS clause.
         (SELECT string_agg(format('%I.%I', pn.nspname, p.relname), ', ' ORDER BY i.inhseqno)
            FROM pg_inherits i
            JOIN pg_class p ON p.oid = i.inhparent
            JOIN pg_namespace pn ON pn.oid = p.relnamespace
            WHERE i.inhrelid = c.oid) AS inherits,
         pn.nspname AS part_schema, p.relname AS part_name,
         CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partbound
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_inherits i ON i.inhrelid = c.oid AND c.relispartition
       LEFT JOIN pg_class p ON p.oid = i.inhparent
       LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace
       WHERE c.oid = $1`,
      [relOid],
    ),
    pool.query(
      `SELECT polname, polcmd, NOT polpermissive AS restrictive,
          (SELECT string_agg(CASE WHEN pol.role_oid = 0 THEN 'PUBLIC'
                                  ELSE quote_ident(r.rolname) END, ', '
                              ORDER BY (pol.role_oid <> 0), r.rolname)
            FROM unnest(p.polroles) AS pol(role_oid)
            LEFT JOIN pg_roles r ON r.oid = pol.role_oid) AS roles,
          pg_get_expr(p.polqual, p.polrelid) AS qual,
          pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
        FROM pg_policy p
        WHERE p.polrelid = $1
        ORDER BY p.polname`,
      [relOid],
    ),
    pool.query(
      `SELECT s.srvname AS server,
         (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || ' ' ||
                   quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord)
            FROM unnest(ft.ftoptions) WITH ORDINALITY AS opt(o, ord)) AS options
       FROM pg_foreign_table ft
       JOIN pg_foreign_server s ON s.oid = ft.ftserver
       WHERE ft.ftrelid = $1`,
      [relOid],
    ),
  ])

  const rel = relRes.rows[0]
  if (!rel) notFound()
  // The object is resolved by oid, so the catalogue's own name is authoritative
  // (the request's schema/name may be stale).
  const table = `${ident(rel.schema)}.${ident(rel.name)}`
  const chunks: string[] = []

  /** Owned sequences by column name, for identity/serial option emission. */
  const sequenceByColumn = new Map<string, SequenceProps & { schema: string; name: string }>()
  for (const r of colsRes.rows) {
    if (r.owned_name != null) {
      sequenceByColumn.set(String(r.name), {
        type: String(r.sequence_type),
        start: String(r.sequence_start),
        increment: String(r.sequence_increment),
        min: String(r.sequence_min),
        max: String(r.sequence_max),
        cache: String(r.sequence_cache),
        cycle: r.sequence_cycle === true,
        schema: String(r.owned_schema),
        name: String(r.owned_name),
      })
    }
  }

  if (rel.relispartition && rel.part_name) {
    // Partition-local constraints and indexes still belong in the DDL: only
    // the parent-cloned ones (filtered out of the queries above) are
    // recreated by the attachment.
    const localConstraints = consRes.rows.map(
      (c) => `ALTER TABLE ${table} ADD CONSTRAINT ${ident(c.conname)} ${String(c.def)};`,
    )
    const localIndexes = idxRes.rows.map((r) => `${r.indexdef};`)
    // pg_get_expr returns bounds in their final form: list/range bounds read
    // "FOR VALUES …", a default partition reads "DEFAULT" (which must NOT be
    // prefixed with FOR VALUES). Only hash bounds need the wrapper.
    const bound = String(rel.partbound ?? '').trim()
    const partitionBound = /^(FOR\s+VALUES|DEFAULT)\b/i.test(bound) ? bound : `FOR VALUES ${bound}`
    // A partition can itself be partitioned; without its own PARTITION BY it
    // would be recreated as a plain table, breaking its own children.
    const subPartition = rel.own_partkey ? `\n  PARTITION BY ${rel.own_partkey}` : ''
    chunks.push(
      `CREATE TABLE ${table}\n  PARTITION OF ${ident(rel.part_schema)}.${ident(rel.part_name)}\n  ${partitionBound}${subPartition};`,
    )
    if (localConstraints.length) chunks.push(localConstraints.join('\n'))
    if (localIndexes.length) chunks.push(localIndexes.join('\n'))
  } else {
    const pkCols = new Set(pkRes.rows.map((r) => r.attname as string))
    // For a plain inheritance child the inherited columns are recreated by the
    // INHERITS clause, so only local columns (attinhcount = 0) are listed —
    // the same shape pg_dump emits.
    const inheritance = rel.relkind !== 'f' && !rel.partkey && rel.inherits ? (rel.inherits as string) : null
    const columns = inheritance ? colsRes.rows.filter((r) => !r.inhcount) : colsRes.rows
    /** A serial column whose sequence carries nondefault options cannot use
     * the shorthand (which always creates a default sequence): the explicit
     * path recreates the sequence, its options and the ownership. */
    const sequenceCreates: string[] = []
    const ownedBy: string[] = []
    const lines = columns.map((r) => {
      const owned = sequenceByColumn.get(String(r.name)) ?? null
      const serial = owned && !r.identity && !r.generated ? serialType(r.type) : null
      const defaultName = `${rel.name}_${r.name}_seq`
      const renamed = owned !== null && (owned.name !== defaultName || owned.schema !== rel.schema)
      // The serial shorthand recreates a sequence of the column's own type:
      // nondefault options, a renamed sequence, or a sequence whose type was
      // altered afterwards must take the explicit path instead.
      const explicitSerial = serial !== null &&
        (owned ? sequenceOptions(owned, null).length > 0 || renamed || owned.type !== r.type : false)
      const sequenceNameClause =
        owned && r.identity && renamed ? `SEQUENCE NAME ${ident(owned.schema)}.${ident(owned.name)}` : null
      if (explicitSerial && owned) {
        const createOptions = sequenceOptions(owned, null)
        sequenceCreates.push(
          `CREATE SEQUENCE ${ident(owned.schema)}.${ident(owned.name)} AS ${owned.type}` +
            (createOptions.length ? ` ${createOptions.join(' ')}` : '') + ';',
        )
        ownedBy.push(`ALTER SEQUENCE ${ident(owned.schema)}.${ident(owned.name)} OWNED BY ${table}.${ident(r.name)};`)
      }
      // The explicit path stores `nextval('<seq>'::regclass)` as typed at
      // creation; re-qualify it so the rebuilt default binds the sequence the
      // script itself just created, whatever search_path says. The regclass
      // name travels as a string literal, so single quotes in it must be
      // doubled, not identifier-quoted.
      const defaultExpr =
        explicitSerial && owned && r.default_value != null
          ? String(r.default_value).replace(
              /^nextval\('(.*)'(?:::regclass)?\)$/i,
              // A callback: `$` in the quoted name must not read as a capture.
              () => `nextval(${regclassLiteral(owned.schema, owned.name)}::regclass)`)
          : r.default_value
      const fdwOptions = r.fdw_options ? ` OPTIONS (${r.fdw_options})` : ''
      const parts = [`${ident(r.name)} ${explicitSerial ? r.type : serial ?? r.type}${fdwOptions}${r.collation ?? ''}`]
      if (r.generated === 's' && r.default_value != null) {
        parts.push(`GENERATED ALWAYS AS (${r.default_value}) STORED`)
      } else if (r.identity === 'a' || r.identity === 'd') {
        const keyword = r.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY'
        const options = owned ? sequenceOptions(owned, sequenceNameClause) : []
        parts.push(options.length ? `${keyword} (${options.join(' ')})` : keyword)
      } else if (r.default_value != null && (!serial || explicitSerial)) {
        parts.push(`DEFAULT ${defaultExpr}`)
      }
      if (r.notnull && !pkCols.has(r.name)) parts.push('NOT NULL')
      return `  ${parts.join(' ')}`
    })

    // A foreign key that references a partitioned table is stored once per
    // partition, so the catalogue returns several clone rows with identical
    // definitions (…_fkey, …_fkey1, …_fkey2). Emitting each as an inline
    // CONSTRAINT makes the names collide, so collapse identical clone rows.
    // Ordinary FKs are not deduped: two same-shaped foreign keys are legal and
    // distinct, and names are unique per relation anyway.
    const seenFkDefs = new Set<string>()
    const deferredConstraints: string[] = []
    for (const c of consRes.rows) {
      const def = String(c.def)
      if (c.is_clone) {
        if (seenFkDefs.has(def)) continue
        seenFkDefs.add(def)
      }
      // CREATE TABLE accepts but silently ignores NOT VALID, so an unvalidated
      // constraint must be added afterwards with ALTER TABLE (as pg_dump does)
      // or it is recreated as validated.
      if (/\bNOT VALID$/i.test(def)) {
        deferredConstraints.push(`ALTER TABLE ${table} ADD CONSTRAINT ${ident(c.conname)} ${def};`)
      } else {
        lines.push(`  CONSTRAINT ${ident(c.conname)} ${def}`)
      }
    }

    const kind = rel.relkind === 'f' ? 'FOREIGN TABLE' : rel.relpersistence === 'u' ? 'UNLOGGED TABLE' : 'TABLE'
    let create = `CREATE ${kind} ${table} (\n${lines.join(',\n')}\n)`
    if (rel.relkind === 'f' && foreignRes.rows[0]) {
      create += `\n  SERVER ${ident(foreignRes.rows[0].server)}`
      if (foreignRes.rows[0].options) create += `\n  OPTIONS (${foreignRes.rows[0].options})`
    }
    if (rel.partkey) create += `\n  PARTITION BY ${rel.partkey}`
    else if (inheritance) create += `\n  INHERITS (${inheritance})`
    if (rel.tablespace) create += `\n  TABLESPACE ${ident(rel.tablespace)}`
    if (sequenceCreates.length) chunks.push(sequenceCreates.join('\n'))
    chunks.push(create + ';')
    if (ownedBy.length) chunks.push(ownedBy.join('\n'))
    if (deferredConstraints.length) chunks.push(deferredConstraints.join('\n'))

    // Constraint-backed indexes are excluded by the query itself; whatever
    // remains is a standalone index for every relation kind.
    if (idxRes.rows.length) {
      chunks.push(idxRes.rows.map((r) => `${r.indexdef};`).join('\n'))
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
  // The commented drop makes the script editable like index/trigger/type
  // scripts: uncommenting it is the user's explicit, destructive choice.
  // Plain IF EXISTS rather than CASCADE — dependent views and foreign keys
  // fail loudly instead of being silently destroyed.
  const drop = `-- DROP TABLE IF EXISTS ${table};`
  return [drop, ...chunks].join('\n\n')
}

export async function viewDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  const relOid = oid || (await resolveOid(pool, schema, name, ['v', 'm']))
  const [viewRes, idxRes] = await Promise.all([
    pool.query(
      `SELECT c.relkind, n.nspname AS schema, c.relname AS name,
         pg_get_viewdef(c.oid, true) AS def,
         pg_get_userbyid(c.relowner) AS owner,
         quote_literal(obj_description(c.oid)) AS comment,
         (SELECT spcname FROM pg_tablespace WHERE oid = c.reltablespace) AS tablespace,
         (SELECT string_agg(quote_ident(split_part(o, '=', 1)) || '=' ||
                   quote_literal(substr(o, strpos(o, '=') + 1)), ', ' ORDER BY ord)
            FROM unnest(c.reloptions) WITH ORDINALITY AS opt(o, ord)) AS reloptions
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`,
      [relOid],
    ),
    // Only materialized views can carry indexes; a plain view returns none.
    pool.query(
      `SELECT pg_get_indexdef(idx.oid) AS indexdef
       FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
       WHERE i.indrelid = $1
       ORDER BY idx.relname`,
      [relOid],
    ),
  ])
  const row = viewRes.rows[0]
  // A non-view oid would make pg_get_viewdef NULL and emit "AS null"; fail
  // cleanly instead.
  if (!row || (row.relkind !== 'v' && row.relkind !== 'm')) notFound()
  const materialized = row.relkind === 'm'
  const target = `${ident(row.schema)}.${ident(row.name)}`
  const definition = String(row.def).trim().replace(/;$/, '')
  const withOptions = row.reloptions ? ` WITH (${row.reloptions})` : ''
  const tablespace = materialized && row.tablespace ? `\n  TABLESPACE ${ident(row.tablespace)}` : ''
  const keyword = materialized ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
  const chunks = [`${keyword} ${target}${withOptions}${tablespace} AS\n${definition};`]
  if (materialized && idxRes.rows.length) {
    chunks.push(idxRes.rows.map((r) => `${r.indexdef};`).join('\n'))
  }
  const kind = materialized ? 'MATERIALIZED VIEW' : 'VIEW'
  if (row.owner) chunks.push(`ALTER ${kind} ${target} OWNER TO ${ident(row.owner)};`)
  if (row.comment) chunks.push(`COMMENT ON ${kind} ${target} IS ${row.comment};`)
  const drop = `-- DROP ${materialized ? 'MATERIALIZED ' : ''}VIEW IF EXISTS ${target};`
  return [drop, ...chunks].join('\n\n')
}

export async function functionDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  let target = oid
  if (!target) {
    const fallback = await pool.query(
      `SELECT p.oid::text AS oid
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f', 'p', 'w', 'a')
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
    // Every function/operator reference is schema-qualified. A bare regproc
    // name resolves through search_path, so the generated script would bind a
    // different object if re-run under a different search_path.
    `SELECT a.aggkind,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggtransfn) AS sfunc,
            format_type(a.aggtranstype, NULL) AS stype,
            NULLIF(a.aggtransspace, 0) AS transspace,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggfinalfn) AS finalfn,
            a.aggfinalextra,
            a.aggfinalmodify,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggcombinefn) AS combinefn,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggserialfn) AS serialfn,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggdeserialfn) AS deserialfn,
            -- quote_literal, not NULLIF(..,''): an empty-string initial
            -- condition is legitimate and must stay distinct from NULL, and
            -- the server quoting is safe regardless of
            -- standard_conforming_strings.
            quote_literal(a.agginitval) AS initcond,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggmtransfn) AS msfunc,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggminvtransfn) AS minvfunc,
            CASE WHEN a.aggmtranstype <> 0 THEN format_type(a.aggmtranstype, NULL) END AS mstype,
            NULLIF(a.aggmtransspace, 0) AS mtransspace,
            (SELECT format('%I.%I', n.nspname, pr.proname) FROM pg_proc pr
               JOIN pg_namespace n ON n.oid = pr.pronamespace WHERE pr.oid = a.aggmfinalfn) AS mfinalfn,
            a.aggmfinalextra,
            a.aggmfinalmodify,
            quote_literal(a.aggminitval) AS minitcond,
            -- aggsortop is a plain oid; resolve it to a schema-qualified
            -- OPERATOR(...) rather than a search_path-dependent regoper name.
            (SELECT 'OPERATOR(' || quote_ident(opn.nspname) || '.' || op.oprname || ')'
               FROM pg_operator op JOIN pg_namespace opn ON opn.oid = op.oprnamespace
               WHERE op.oid = a.aggsortop) AS sortop,
            p.proparallel
     FROM pg_aggregate a
     JOIN pg_proc p ON p.oid = a.aggfnoid
     WHERE a.aggfnoid = $1::oid`,
    [oid],
  )
  const row = res.rows[0]
  if (!row) notFound()
  // The catalog's finalfuncmodify is a char: r/s/w. The DDL keyword is only
  // written when it differs from the default for this aggregate kind, which is
  // READ_ONLY for ordinary aggregates and READ_WRITE for ordered-set ones.
  const modifyKeyword = (v: unknown): string | null =>
    v === 'r' ? 'READ_ONLY' : v === 's' ? 'SHAREABLE' : v === 'w' ? 'READ_WRITE' : null
  const defaultModify = row.aggkind === 'n' ? 'r' : 'w'

  const opts = [`SFUNC = ${row.sfunc}`, `STYPE = ${row.stype}`]
  if (row.transspace != null) opts.push(`SSPACE = ${row.transspace}`)
  if (row.finalfn) opts.push(`FINALFUNC = ${row.finalfn}`)
  if (row.aggfinalextra) opts.push('FINALFUNC_EXTRA')
  if (row.finalfn && row.aggfinalmodify !== defaultModify) {
    const kw = modifyKeyword(row.aggfinalmodify)
    if (kw) opts.push(`FINALFUNC_MODIFY = ${kw}`)
  }
  if (row.combinefn) opts.push(`COMBINEFUNC = ${row.combinefn}`)
  if (row.serialfn) opts.push(`SERIALFUNC = ${row.serialfn}`)
  if (row.deserialfn) opts.push(`DESERIALFUNC = ${row.deserialfn}`)
  if (row.initcond != null) opts.push(`INITCOND = ${row.initcond}`)
  if (row.msfunc) opts.push(`MSFUNC = ${row.msfunc}`)
  if (row.minvfunc) opts.push(`MINVFUNC = ${row.minvfunc}`)
  if (row.mstype) opts.push(`MSTYPE = ${row.mstype}`)
  if (row.mtransspace != null) opts.push(`MSSPACE = ${row.mtransspace}`)
  if (row.mfinalfn) opts.push(`MFINALFUNC = ${row.mfinalfn}`)
  if (row.aggmfinalextra) opts.push('MFINALFUNC_EXTRA')
  if (row.mfinalfn && row.aggmfinalmodify !== defaultModify) {
    const kw = modifyKeyword(row.aggmfinalmodify)
    if (kw) opts.push(`MFINALFUNC_MODIFY = ${kw}`)
  }
  if (row.minitcond != null) opts.push(`MINITCOND = ${row.minitcond}`)
  if (row.sortop) opts.push(`SORTOP = ${row.sortop}`)
  if (row.proparallel === 's') opts.push('PARALLEL = SAFE')
  else if (row.proparallel === 'r') opts.push('PARALLEL = RESTRICTED')
  // HYPOTHETICAL is only meaningful for ordered-set aggregates and must be
  // emitted, otherwise PostgreSQL recreates them as ordinary ordered-set ones.
  if (row.aggkind === 'h') opts.push('HYPOTHETICAL')

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
       WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype IN ('e', 'c', 'd', 'r')
       ORDER BY t.oid
       LIMIT 1`,
      [schema, name],
    )
    if (!fallback.rows[0]) notFound()
    target = fallback.rows[0].oid
  }
  const res = await pool.query(
    `SELECT t.typtype, t.typnotnull, n.nspname AS schema, t.typname AS name,
       -- typdefault is the *external* representation when typdefaultbin is
       -- set (e.g. 'abc' without its quotes for a text domain), so emitting it raw
       -- produces unrunnable DDL. pg_get_expr renders the parsed default
       -- back as executable SQL, same as the column-default path above.
       pg_get_expr(t.typdefaultbin, 0) AS typdefault,
       format_type(t.typbasetype, t.typtypmod) AS base,
       -- format_type drops a domain's collation, so reattach it explicitly
       -- (the default collation is implicit and can be omitted).
       (SELECT quote_ident(dcn.nspname) || '.' || quote_ident(dc.collname)
          FROM pg_collation dc JOIN pg_namespace dcn ON dcn.oid = dc.collnamespace
          WHERE dc.oid = t.typcollation AND t.typcollation <> 0 AND dc.collname <> 'default') AS domain_collation,
       (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels,
        (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN co.collname IS NOT NULL AND co.collname <> 'default'
                     THEN ' COLLATE ' || quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                     ELSE '' END, ', ' ORDER BY a.attnum)
          FROM pg_attribute a
          LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
          LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
          WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attrs,
       (SELECT string_agg('CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), ' ' ORDER BY c.oid)
          FROM pg_constraint c WHERE c.contypid = t.oid) AS cons,
       format_type(r.rngsubtype, NULL) AS subtype,
       -- rngsubopc is a plain oid, not a regclass: casting it straight to
       -- ::regclass::text renders the numeric oid, which SUBTYPE_OPCLASS
       -- rejects. Resolve the name from pg_opclass instead.
       (SELECT quote_ident(ocn.nspname) || '.' || quote_ident(oc.opcname)
          FROM pg_opclass oc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace
          WHERE oc.oid = r.rngsubopc) AS subopc,
       (SELECT quote_ident(rcn.nspname) || '.' || quote_ident(rc.collname)
          FROM pg_collation rc JOIN pg_namespace rcn ON rcn.oid = rc.collnamespace
          WHERE rc.oid = r.rngcollation AND r.rngcollation <> 0 AND rc.collname <> 'default') AS collation,
       -- PG names the multirange <range>_multirange. Only emit the option
       -- when the actual name differs, so the generated DDL works on the
       -- server version it came from without probing. Schema-qualify it: the
       -- option accepts a qualified name and the multirange may live elsewhere.
       (SELECT format('%I.%I', mn.nspname, mt.typname)
          FROM pg_type mt
          JOIN pg_namespace mn ON mn.oid = mt.typnamespace
          WHERE mt.oid = (SELECT x.rngmultitypid FROM pg_range x WHERE x.rngtypid = t.oid)
            AND mt.typname <> t.typname || '_multirange'
            AND mt.typname <> '_' || t.typname) AS multirange_name,
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
  const q = `${ident(row.schema)}.${ident(row.name)}`
  let ddl: string
  if (row.typtype === 'e') {
    ddl = `CREATE TYPE ${q} AS ENUM (${row.labels ?? ''});`
  } else if (row.typtype === 'c') {
    ddl = `CREATE TYPE ${q} AS (${row.attrs ?? ''});`
  } else if (row.typtype === 'd') {
    const parts = [`CREATE DOMAIN ${q} AS ${row.base}`]
    if (row.domain_collation) parts.push(`COLLATE ${row.domain_collation}`)
    if (row.typdefault != null) parts.push(`DEFAULT ${row.typdefault}`)
    if (row.typnotnull) parts.push('NOT NULL')
    if (row.cons) parts.push(String(row.cons).trim())
    ddl = parts.join(' ') + ';'
  } else if (row.typtype === 'r') {
    const opts = [`SUBTYPE = ${row.subtype}`]
    if (row.subopc) opts.push(`SUBTYPE_OPCLASS = ${row.subopc}`)
    if (row.collation) opts.push(`COLLATION = ${row.collation}`)
    if (row.canonical && row.canonical !== '-') opts.push(`CANONICAL = ${row.canonical}`)
    if (row.subdiff && row.subdiff !== '-') opts.push(`SUBTYPE_DIFF = ${row.subdiff}`)
    if (row.multirange_name) opts.push(`MULTIRANGE_TYPE_NAME = ${row.multirange_name}`)
    ddl = `CREATE TYPE ${q} AS RANGE (\n  ${opts.join(',\n  ')}\n);`
  } else {
    notFound()
  }
  const drop = row.typtype === 'd' ? `-- DROP DOMAIN IF EXISTS ${q};` : `-- DROP TYPE IF EXISTS ${q};`
  return `${drop}\n\n${ddl}`
}

export async function sequenceDdl(pool: Pool, oid: string, schema: string, name: string): Promise<string> {
  let target = oid
  if (!target) {
    const fallback = await pool.query(
      `SELECT c.oid::text AS oid
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       LIMIT 1`,
      [schema, name],
    )
    if (!fallback.rows[0]) notFound()
    target = fallback.rows[0].oid
  }
  const res = await pool.query(
    `SELECT s.seqtypid, s.seqstart, s.seqincrement, s.seqmin, s.seqmax,
            s.seqcache, s.seqcycle, c.relname AS name, n.nspname AS schema,
            format_type(s.seqtypid, NULL) AS data_type,
            -- Ownership: the column this sequence generates for, when any.
            (SELECT format('%I.%I.%I', tn.nspname, t.relname, a.attname)
               FROM pg_depend d
               JOIN pg_class t ON t.oid = d.refobjid
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
               JOIN pg_namespace tn ON tn.oid = t.relnamespace
              WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
              LIMIT 1) AS owned_by
     FROM pg_sequence s
     JOIN pg_class c ON c.oid = s.seqrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = $1::oid`,
    [target],
  )
  const row = res.rows[0]
  if (!row) notFound()
  const q = `${ident(row.schema)}.${ident(row.name)}`
  const props = {
    type: String(row.data_type),
    start: String(row.seqstart),
    increment: String(row.seqincrement),
    min: String(row.seqmin),
    max: String(row.seqmax),
    cache: String(row.seqcache),
    cycle: row.seqcycle === true,
  }
  const opts = sequenceOptions(props, null)
  // Options only when they differ from a bare creation; OWNED BY is emitted
  // only when the dependency exists (serial/identity columns own theirs).
  let create = `CREATE SEQUENCE ${q} AS ${props.type}`
  if (opts.length) create += ` ${opts.join(' ')}`
  if (row.owned_by) create += ` OWNED BY ${String(row.owned_by)}`
  const ddl = `${create};`
  const drop = `-- DROP SEQUENCE IF EXISTS ${q};`
  return `${drop}\n\n${ddl}`
}

/** The object types the DDL generators cover; the route and the AI tool both
 * validate against this list. */
export const DDL_TYPES = ['table', 'view', 'function', 'index', 'constraint', 'trigger', 'type', 'sequence']

/** A DDL request as the browser and the agent send it: the type selects the
 * generator, `oid` wins over `schema`/`name` where a generator resolves by
 * oid, and `parent` names the owning table for constraints and triggers. */
export interface DdlTarget {
  type: string
  schema: string
  name: string
  oid?: string
  parent?: string
}

/** Generate the DDL for one object — the one dispatcher shared by the HTTP
 * route and the AI tool. Unknown types are a 400; missing objects come from
 * the generators as 404. */
export async function objectDdl(pool: Pool, request: DdlTarget): Promise<string> {
  const oid = request.oid ?? ''
  const parent = request.parent ?? ''
  switch (request.type) {
    case 'table':
      return tableDdl(pool, oid, request.schema, request.name)
    case 'view':
      return viewDdl(pool, oid, request.schema, request.name)
    case 'function':
      return functionDdl(pool, oid, request.schema, request.name)
    case 'index':
      return indexDdl(pool, request.schema, request.name)
    case 'constraint':
      return constraintDdl(pool, request.schema, parent, request.name)
    case 'trigger':
      return triggerDdl(pool, request.schema, parent, request.name)
    case 'type':
      return typeDdl(pool, oid, request.schema, request.name)
    case 'sequence':
      return sequenceDdl(pool, oid, request.schema, request.name)
    default: {
      const err: Error & { statusCode: number } = Object.assign(
        new Error(`Unknown object type: ${request.type}`),
        { statusCode: 400 },
      )
      throw err
    }
  }
}
