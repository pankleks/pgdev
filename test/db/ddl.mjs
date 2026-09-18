// DDL round-trips for object shapes the other suites do not assert: RLS
// policies, list and hash partitions, composite and enum types, and index
// variants. Everything runs inside a database this suite owns.
import { credentials, scratchDatabase, counters, roundTrip } from '../lib/db.mjs'

const base = await credentials()
const DB = `pgdev_ddltest_${process.pid}`
const { pool, teardown } = await scratchDatabase(base, DB)
const { eq, ok, report } = counters()

const ddl = await import('../../server/dist/catalog/ddl.js')
const oidOfRel = async (name) => (await pool.query(`SELECT $1::regclass::oid::text AS o`, [`public.${name}`])).rows[0]?.o
const oidOfType = async (name) => (await pool.query(`SELECT oid::text AS o FROM pg_type WHERE typname=$1`, [name])).rows[0]?.o
const tableFp = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, c.relkind,
    pg_get_expr(c.relpartbound, c.oid) AS bound,
    (SELECT pg_get_partkeydef(p.partrelid) FROM pg_partitioned_table p WHERE p.partrelid = c.oid) AS partkey
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`
const policyFp = `SELECT p.polname, p.polcmd, p.polpermissive,
    (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY(p.polroles)) AS roles,
    pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname=$1 ORDER BY p.polname`
const indexFp = `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`
const typeFp = `SELECT t.typname, t.typtype,
    COALESCE((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid),'') AS labels,
    COALESCE((SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped),'') AS attrs
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=$1`

// ---------------------------------------------------------------- fixtures
const ROLES = ['pgdev_ddl_reader', 'pgdev_ddl_writer']
for (const r of ROLES) await pool.query(`DROP ROLE IF EXISTS ${r}`)
for (const r of ROLES) await pool.query(`CREATE ROLE ${r} NOLOGIN`)
await pool.query(`CREATE TABLE base (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)`)
await pool.query(`INSERT INTO base (label) SELECT 'r'||g FROM generate_series(1,20) g`)
await pool.query(`CREATE TABLE rls_table (id integer PRIMARY KEY, owner_name text NOT NULL, payload text)`)
await pool.query(`CREATE TABLE list_parent (region text NOT NULL, id integer NOT NULL, PRIMARY KEY (region, id)) PARTITION BY LIST (region)`)
await pool.query(`CREATE TABLE hash_parent (id integer NOT NULL, v text, PRIMARY KEY (id)) PARTITION BY HASH (id)`)

console.log('\n== table DDL: row level security ==')
await pool.query(`ALTER TABLE rls_table ENABLE ROW LEVEL SECURITY`)
await pool.query(`ALTER TABLE rls_table FORCE ROW LEVEL SECURITY`)
await pool.query(`CREATE POLICY own_rows ON rls_table FOR SELECT TO pgdev_ddl_reader USING (owner_name = CURRENT_USER)`)
await pool.query(`CREATE POLICY no_delete ON rls_table AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false)`)
await pool.query(`CREATE POLICY ins_chk ON rls_table FOR INSERT TO pgdev_ddl_writer WITH CHECK (owner_name <> '')`)
await roundTrip({
  pool, eq, ok, params: ['rls_table'], create: [], drop: `DROP TABLE rls_table CASCADE`,
  label: 'RLS table (enable + force, permissive/restrictive, roles, USING/WITH CHECK)',
  fingerprint: tableFp,
  ddl: async () => {
    const text = await ddl.tableDdl(pool, await oidOfRel('rls_table'), 'public', 'rls_table')
    // recreate the policies the table DDL emitted, none exist after the drop
    return text
  },
})
{
  // policies are part of the table DDL, so assert them directly too
  const text = await ddl.tableDdl(pool, await oidOfRel('rls_table'), 'public', 'rls_table')
  ok('emits ENABLE ROW LEVEL SECURITY', /ENABLE ROW LEVEL SECURITY/.test(text))
  ok('ENABLE precedes FORCE', text.indexOf('ENABLE ROW LEVEL SECURITY') < text.indexOf('FORCE ROW LEVEL SECURITY'))
  ok('emits a restrictive policy', /AS RESTRICTIVE/.test(text))
  // quote_ident only quotes when necessary, so assert the role is named
  // correctly rather than that it is quoted
  ok('names the policy role', /TO pgdev_ddl_reader/.test(text))
  ok('names PUBLIC for the restrictive policy', /TO PUBLIC/.test(text))
  ok('opens a fresh policy line with TO', /\n\s+FOR (SELECT|INSERT|DELETE|ALL) TO /.test(text))
  ok('emits USING and WITH CHECK', /USING \(\(owner_name = CURRENT_USER\)\)/.test(text) && /WITH CHECK/.test(text))
}

console.log('\n== table DDL: list and hash partitions ==')
await pool.query(`CREATE TABLE list_eu PARTITION OF list_parent FOR VALUES IN ('eu','uk')`)
await pool.query(`CREATE TABLE list_def PARTITION OF list_parent DEFAULT`)
await pool.query(`CREATE TABLE hash_0 PARTITION OF hash_parent FOR VALUES WITH (MODULUS 2, REMAINDER 0)`)
await pool.query(`CREATE TABLE hash_1 PARTITION OF hash_parent FOR VALUES WITH (MODULUS 2, REMAINDER 1)`)

for (const [child, expect] of [
  ['list_eu', /FOR VALUES IN \('eu', 'uk'\)/],
  ['list_def', /DEFAULT/],
  ['hash_0', /FOR VALUES WITH \(modulus 2, remainder 0\)/i],
  ['hash_1', /FOR VALUES WITH \(modulus 2, remainder 1\)/i],
]) {
  const text = await ddl.tableDdl(pool, await oidOfRel(child), 'public', child)
  ok(`${child} emits its bound`, expect.test(text), text.split('\n').find((l) => /VALUES|DEFAULT/.test(l))?.trim())
  ok(`${child} does not emit FOR VALUES DEFAULT`, !/FOR VALUES DEFAULT/i.test(text))
  ok(`${child} attaches to the right parent`, /PARTITION OF "public"\."(list|hash)_parent"/.test(text))
}

// full rebuild of the list partition: parent then child
await roundTrip({
  pool, eq, ok, params: ['list_eu'], create: [], drop: `DROP TABLE list_eu`,
  label: 'list partition (rebuild from parent + child DDL)',
  fingerprint: tableFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('list_eu'), 'public', 'list_eu'),
})

console.log('\n== partition-local constraints and indexes ==')
await pool.query(`CREATE TABLE list_loc PARTITION OF list_parent FOR VALUES IN ('fr','de')`)
await pool.query(`ALTER TABLE list_loc ADD CONSTRAINT loc_chk CHECK (id > 100)`)
await pool.query(`CREATE INDEX loc_idx ON list_loc (id)`)
await roundTrip({
  pool, eq, ok, params: ['list_loc'], create: [], drop: `DROP TABLE list_loc`,
  label: 'partition-local CHECK and index survive the round-trip',
  fingerprint: `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname = $1 AND con.conname = 'loc_chk'`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('list_loc'), 'public', 'list_loc'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('list_loc'), 'public', 'list_loc')
  ok('emits the partition-local CHECK', /ADD CONSTRAINT "loc_chk" CHECK \(\(id > 100\)\)/.test(text),
    text.split('\n').find((l) => /loc_chk/.test(l))?.trim())
  ok('emits the partition-local index', /CREATE INDEX "?loc_idx"? ON/.test(text),
    text.split('\n').find((l) => /loc_idx/.test(l))?.trim())
  // Parent-cloned objects must NOT appear: the attachment recreates them.
  ok('omits the cloned primary key', !/list_loc_pkey|CONSTRAINT .* PRIMARY KEY/.test(text),
    text.split('\n').find((l) => /pkey|PRIMARY KEY/.test(l))?.trim())
  ok('cloned CHECKs do not collide with the local one',
    (text.match(/ADD CONSTRAINT/g) ?? []).length === 1)
}
await pool.query(`DROP TABLE list_loc`)

console.log('\n== index variants ==')
for (const [label, create, name] of [
  ['partial index', `CREATE INDEX idx_partial ON base (label) WHERE id > 10`, 'idx_partial'],
  ['expression index', `CREATE INDEX idx_expr ON base (lower(label))`, 'idx_expr'],
  ['INCLUDE index', `CREATE INDEX idx_incl ON base (id) INCLUDE (label)`, 'idx_incl'],
  ['gin index', `CREATE INDEX idx_gin ON base USING gin (to_tsvector('simple', label))`, 'idx_gin'],
  ['brin index', `CREATE INDEX idx_brin ON base USING brin (id)`, 'idx_brin'],
  ['unique index', `CREATE UNIQUE INDEX idx_uniq ON base (label)`, 'idx_uniq'],
]) {
  await pool.query(create)
  await roundTrip({
    pool, eq, ok, params: ['base'], create: [], drop: `DROP INDEX ${name}`,
    label, fingerprint: indexFp,
    ddl: async () => ddl.indexDdl(pool, 'public', name),
  })
}

console.log('\n== constraint variants ==')
await pool.query(`CREATE TABLE cons (a integer, b integer, c text,
  CONSTRAINT cons_pk PRIMARY KEY (a),
  CONSTRAINT cons_chk CHECK (b > 0),
  CONSTRAINT cons_uniq UNIQUE (c) DEFERRABLE INITIALLY DEFERRED)`)
for (const name of ['cons_pk', 'cons_chk', 'cons_uniq']) {
  const text = await ddl.constraintDdl(pool, 'public', 'cons', name)
  const def = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname=$1`, [name])).rows[0].d
  ok(`${name} DDL carries its definition`, text.includes(def), def)
  ok(`${name} DDL is an ALTER TABLE ADD CONSTRAINT`, /ADD CONSTRAINT/.test(text))
}
await pool.query(`CREATE TABLE fk_child (id integer PRIMARY KEY, p integer, CONSTRAINT fk_c FOREIGN KEY (p) REFERENCES cons(a) ON DELETE CASCADE ON UPDATE RESTRICT)`)
{
  const text = await ddl.constraintDdl(pool, 'public', 'fk_child', 'fk_c')
  ok('FK keeps ON DELETE CASCADE', /ON DELETE CASCADE/.test(text))
  ok('FK keeps ON UPDATE RESTRICT', /ON UPDATE RESTRICT/.test(text))
  const def = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='fk_c'`)).rows[0].d
  ok('FK matches pg_get_constraintdef', text.includes(def), def)
}
await pool.query(`ALTER TABLE cons ADD CONSTRAINT cons_notvalid CHECK (b < 1000) NOT VALID`)
{
  const text = await ddl.constraintDdl(pool, 'public', 'cons', 'cons_notvalid')
  ok('NOT VALID constraint is preserved', /NOT VALID/.test(text), text.trim().split('\n').pop())
}

console.log('\n== foreign key variants ==')
{
  const version = Number((await pool.query(`SELECT current_setting('server_version_num') AS v`)).rows[0].v)
  const setNullCols = version >= 150000 ? ', CONSTRAINT fk_setnull FOREIGN KEY (r) REFERENCES cons(a) ON DELETE SET NULL (r)' : ''
  await pool.query(`CREATE TABLE fk_variants (id integer PRIMARY KEY, p integer, q integer, r integer,
    CONSTRAINT fk_match FOREIGN KEY (p) REFERENCES cons(a) MATCH FULL,
    CONSTRAINT fk_ok FOREIGN KEY (q) REFERENCES cons(a)${setNullCols})`)
  await pool.query(`ALTER TABLE fk_variants ADD CONSTRAINT fk_notvalid FOREIGN KEY (q) REFERENCES cons(a) NOT VALID`)
  await roundTrip({
    pool, eq, ok, params: ['fk_variants'],
    create: [], drop: `DROP TABLE fk_variants`,
    label: 'foreign key MATCH FULL / NOT VALID / SET NULL columns',
    fingerprint: `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname = $1 AND con.contype = 'f' ORDER BY con.conname`,
    ddl: async () => ddl.tableDdl(pool, await oidOfRel('fk_variants'), 'public', 'fk_variants'),
  })
  const text = await ddl.tableDdl(pool, await oidOfRel('fk_variants'), 'public', 'fk_variants')
  ok('table DDL keeps MATCH FULL', /MATCH FULL/.test(text))
  ok('table DDL keeps NOT VALID', /NOT VALID/.test(text))
  if (version >= 150000) {
    ok('table DDL keeps the SET NULL column list', /ON DELETE SET NULL \(r\)/.test(text),
      text.split('\n').find((l) => /fk_setnull/.test(l))?.trim())
  }
}

console.log('\n== exclusion constraint and trigger round-trips ==')
await pool.query(`CREATE TABLE excl_tbl (id integer PRIMARY KEY, during tstzrange NOT NULL,
  CONSTRAINT excl_no_overlap EXCLUDE USING gist (during WITH &&))`)
await roundTrip({
  pool, eq, ok, params: ['excl_tbl'], create: [], drop: `DROP TABLE excl_tbl`,
  label: 'exclusion constraint round-trips (gist on tstzrange, no extension)',
  fingerprint: `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = $1 AND con.contype = 'x'`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('excl_tbl'), 'public', 'excl_tbl'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('excl_tbl'), 'public', 'excl_tbl')
  ok('emits the EXCLUDE clause', /EXCLUDE USING gist/.test(text),
    text.split('\n').find((l) => /EXCLUDE/.test(l))?.trim())
}
await pool.query(`CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.label := upper(NEW.label); RETURN NEW; END $$`)
await pool.query(`CREATE TABLE trg_tbl (id integer PRIMARY KEY, label text)`)
await pool.query(`CREATE TRIGGER trg_when BEFORE INSERT OR UPDATE OF label ON trg_tbl FOR EACH ROW WHEN (NEW.label IS DISTINCT FROM 'untouched') EXECUTE FUNCTION trg_fn()`)
await roundTrip({
  pool, eq, ok, params: ['trg_when'], create: [],
  drop: `DROP TRIGGER trg_when ON trg_tbl`,
  label: 'trigger with UPDATE OF column list and WHEN round-trips',
  fingerprint: `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = $1 AND NOT t.tgisinternal`,
  ddl: async () => ddl.triggerDdl(pool, 'public', 'trg_tbl', 'trg_when'),
})
{
  const text = await ddl.triggerDdl(pool, 'public', 'trg_tbl', 'trg_when')
  ok('trigger DDL keeps the column list', /UPDATE OF "?label"?/.test(text),
    text.split('\n').find((l) => /UPDATE OF/.test(l))?.trim())
  ok('trigger DDL keeps the WHEN condition', /WHEN \(\(/.test(text),
    text.split('\n').find((l) => /WHEN/.test(l))?.trim())
}
await pool.query(`DROP TABLE excl_tbl`)
await pool.query(`DROP TABLE trg_tbl CASCADE`)
await pool.query(`DROP FUNCTION trg_fn()`)

console.log('\n== column collation ==')
await pool.query(`CREATE TABLE collated (id integer, name text COLLATE "C", label text COLLATE "C" NOT NULL)`)
await roundTrip({
  pool, eq, ok, params: ['collated'], create: [], drop: `DROP TABLE collated`,
  label: 'column COLLATE round-trips',
  fingerprint: `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
      co.collname
    FROM pg_attribute a
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
    WHERE a.attrelid = format('public.%I', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('collated'), 'public', 'collated'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('collated'), 'public', 'collated')
  ok('emits the column collation', /"name" text COLLATE pg_catalog\."C"/.test(text),
    text.split('\n').find((l) => /"name"/.test(l))?.trim())
}

console.log('\n== primary key with INCLUDE ==')
await pool.query(`CREATE TABLE pk_include (
  a integer NOT NULL,
  b integer NOT NULL,
  CONSTRAINT pk_include_pk PRIMARY KEY (a) INCLUDE (b))`)
await roundTrip({
  pool, eq, ok, params: ['pk_include'], create: [], drop: `DROP TABLE pk_include`,
  label: 'NOT NULL INCLUDE column survives the primary key',
  fingerprint: `SELECT a.attname, a.attnotnull,
      (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
       WHERE con.conrelid = a.attrelid AND con.contype = 'p') AS pk
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('pk_include'), 'public', 'pk_include'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('pk_include'), 'public', 'pk_include')
  ok('keeps NOT NULL on the INCLUDE column', /"b" integer NOT NULL/.test(text),
    text.split('\n').find((l) => /"b"/.test(l))?.trim())
}

console.log('\n== table inheritance (INHERITS) ==')
await pool.query(`CREATE TABLE inh_parent (id integer NOT NULL, note text,
  CONSTRAINT inh_parent_chk CHECK (id > 0))`)
await pool.query(`CREATE TABLE inh_child (extra text) INHERITS (inh_parent)`)
await roundTrip({
  pool, eq, ok, params: ['inh_child'], create: [], drop: `DROP TABLE inh_child`,
  label: 'plain inheritance child rebuilds through INHERITS',
  fingerprint: `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull, a.attinhcount
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('inh_child'), 'public', 'inh_child'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('inh_child'), 'public', 'inh_child')
  ok('emits INHERITS with the parent', /INHERITS \(public\.inh_parent\)/.test(text),
    text.split('\n').find((l) => /INHERITS/.test(l))?.trim())
  ok('does not redeclare the inherited column', !/"id" integer/.test(text))
}

console.log('\n== identity and serial sequence options ==')
const seqFp = `SELECT c.relname AS seqname, format_type(s.seqtypid, NULL) AS type,
    s.seqstart::text AS start, s.seqincrement::text AS inc, s.seqmin::text AS min,
    s.seqmax::text AS max, s.seqcache::text AS cache, s.seqcycle AS cycle
  FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE c.relname = $1`
await pool.query(`CREATE TABLE opt_ident (
  plain bigint GENERATED ALWAYS AS IDENTITY,
  custom bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 10 MINVALUE 50 MAXVALUE 1000 CACHE 5 CYCLE)
)`)
await roundTrip({
  pool, eq, ok, params: ['opt_ident_custom_seq'], create: [], drop: `DROP TABLE opt_ident CASCADE`,
  label: 'identity with custom sequence options round-trips',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('opt_ident'), 'public', 'opt_ident'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('opt_ident'), 'public', 'opt_ident')
  ok('plain identity stays bare', /"plain" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,/.test(text),
    text.split('\n').find((l) => /plain/.test(l))?.trim())
  const customLine = (text.split('\n').find((l) => /"custom"/.test(l)) ?? '').trim()
  ok('custom identity emits its options',
    /"custom" bigint GENERATED BY DEFAULT AS IDENTITY \(MINVALUE 50 MAXVALUE 1000 START WITH 100 INCREMENT BY 10 CACHE 5 CYCLE\) NOT NULL$/.test(customLine), customLine)
}

// A renamed identity sequence must come back under the same name.
await pool.query(`CREATE TABLE opt_ident2 (id bigint GENERATED ALWAYS AS IDENTITY)`)
await pool.query(`ALTER SEQUENCE opt_ident2_id_seq RENAME TO opt_ident2_moved`)
await roundTrip({
  pool, eq, ok, params: ['opt_ident2_moved'], create: [], drop: `DROP TABLE opt_ident2 CASCADE`,
  label: 'renamed identity sequence keeps its name',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('opt_ident2'), 'public', 'opt_ident2'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('opt_ident2'), 'public', 'opt_ident2')
  ok('emits SEQUENCE NAME for the rename',
    /GENERATED ALWAYS AS IDENTITY \(SEQUENCE NAME "public"\."opt_ident2_moved"\)/.test(text),
    text.split('\n').find((l) => /SEQUENCE NAME/.test(l))?.trim())
}

// A serial column with nondefault sequence options: the shorthand would
// create a default sequence, so the DDL must take the explicit path.
await pool.query(`CREATE TABLE opt_serial (id serial)`)
await pool.query(`ALTER SEQUENCE opt_serial_id_seq INCREMENT BY 10 START WITH 500 CACHE 5`)
await roundTrip({
  pool, eq, ok, params: ['opt_serial_id_seq'], create: [], drop: `DROP TABLE opt_serial CASCADE`,
  label: 'serial with nondefault options round-trips',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('opt_serial'), 'public', 'opt_serial'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('opt_serial'), 'public', 'opt_serial')
  ok('serial options take the explicit sequence path',
    /CREATE SEQUENCE "public"\."opt_serial_id_seq" AS integer START WITH 500 INCREMENT BY 10 CACHE 5;/.test(text),
    text.split('\n').find((l) => /CREATE SEQUENCE/.test(l))?.trim())
  ok('the explicit default binds the created sequence',
    /DEFAULT nextval\('"public"\."opt_serial_id_seq"'::regclass\)/.test(text) ||
      /DEFAULT nextval\('public\.opt_serial_id_seq'::regclass\)/.test(text),
    text.split('\n').find((l) => /DEFAULT nextval/.test(l))?.trim())
  ok('the ownership survives', /ALTER SEQUENCE "public"\."opt_serial_id_seq" OWNED BY "public"\."opt_serial"\."id";/.test(text),
    text.split('\n').find((l) => /OWNED BY/.test(l))?.trim())
}

// Bounds that exclude the position a naive ALTER would validate against.
await pool.query(`CREATE SEQUENCE opt_serial2_id_seq AS integer MINVALUE 50 MAXVALUE 1000 START WITH 100 INCREMENT BY 10`)
await pool.query(`CREATE TABLE opt_serial2 (id integer NOT NULL DEFAULT nextval('opt_serial2_id_seq'::regclass))`)
await pool.query(`ALTER SEQUENCE opt_serial2_id_seq OWNED BY opt_serial2.id`)
await roundTrip({
  pool, eq, ok, params: ['opt_serial2_id_seq'], create: [], drop: `DROP TABLE opt_serial2 CASCADE`,
  label: 'serial bounds excluding the fresh position round-trip',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('opt_serial2'), 'public', 'opt_serial2'),
})
await pool.query(`DROP TABLE opt_serial CASCADE`)

// A sequence whose name carries a single quote: the regenerated default
// travels as a string literal, so the quote must be doubled there.
await pool.query(`CREATE SEQUENCE "odd'seq" AS integer`)
await pool.query(`CREATE TABLE probe_quoted (id integer NOT NULL DEFAULT nextval('"odd''seq"'::regclass))`)
await pool.query(`ALTER SEQUENCE "odd'seq" OWNED BY probe_quoted.id`)
await roundTrip({
  pool, eq, ok, params: ["odd'seq"], create: [], drop: `DROP TABLE probe_quoted CASCADE`,
  label: 'a quoted sequence name round-trips with its quote',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('probe_quoted'), 'public', 'probe_quoted'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('probe_quoted'), 'public', 'probe_quoted')
  ok('the quoted name doubles its quote inside the default',
    /DEFAULT nextval\('"public"\."odd''seq"'::regclass\)/.test(text),
    text.split('\n').find((l) => /DEFAULT nextval/.test(l))?.trim())
}

// An integer column owning a bigint sequence (default options): the serial
// shorthand would recreate an integer sequence, losing the altered type.
await pool.query(`CREATE SEQUENCE probe_bigint_seq AS bigint`)
await pool.query(`CREATE TABLE probe_typemix (id integer NOT NULL DEFAULT nextval('probe_bigint_seq'::regclass))`)
await pool.query(`ALTER SEQUENCE probe_bigint_seq OWNED BY probe_typemix.id`)
await roundTrip({
  pool, eq, ok, params: ['probe_bigint_seq'], create: [], drop: `DROP TABLE probe_typemix CASCADE`,
  label: 'a type-mismatched owned sequence keeps its type',
  fingerprint: seqFp,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('probe_typemix'), 'public', 'probe_typemix'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('probe_typemix'), 'public', 'probe_typemix')
  ok('the type-mismatched sequence takes the explicit path',
    /CREATE SEQUENCE "public"\."probe_bigint_seq" AS bigint;/.test(text) && !/ serial/.test(text),
    text.split('\n').filter((l) => /CREATE SEQUENCE| serial/.test(l)).map((l) => l.trim()).join(' | '))
}
await pool.query(`DROP TABLE probe_quoted CASCADE`)

console.log('\n== composite and enum types ==')
await roundTrip({
  pool, eq, ok, params: ['addr'], create: `CREATE TYPE addr AS (street text, city text, zip integer)`,
  drop: `DROP TYPE addr`, label: 'composite type', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('addr'), 'public', 'addr'),
})
await roundTrip({
  pool, eq, ok, params: ['mood'], create: `CREATE TYPE mood AS ENUM ('sad','ok','happy')`,
  drop: `DROP TYPE mood`, label: 'enum type', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('mood'), 'public', 'mood'),
})
await roundTrip({
  pool, eq, ok, params: ['odd labels'],
  create: `CREATE TYPE "odd labels" AS ENUM ('', 'has space', 'quote''s', 'ünïcøde')`,
  drop: `DROP TYPE "odd labels"`, label: 'enum with awkward labels', fingerprint: typeFp,
  ddl: async () => ddl.typeDdl(pool, await oidOfType('odd labels'), 'public', 'odd labels'),
})

console.log('\n== catalog resolution guards ==')
await pool.query(`CREATE VIEW guard_view AS SELECT 1 AS one`)
{
  const threw = async (fn) => { try { await fn(); return null } catch (e) { return e } }
  // viewDdl must refuse a table oid rather than emit "AS null"
  const viewErr = await threw(async () => ddl.viewDdl(pool, await oidOfRel('base'), 'public', 'base'))
  ok('viewDdl rejects a table oid', viewErr && viewErr.statusCode === 404)
  // tableDdl name fallback must ignore a view of the same name
  const tableErr = await threw(() => ddl.tableDdl(pool, '', 'public', 'guard_view'))
  ok('tableDdl name fallback ignores a view', tableErr && tableErr.statusCode === 404)
  // A valid oid wins over a stale request name: the catalogue name is emitted.
  const text = await ddl.tableDdl(pool, await oidOfRel('base'), 'public', 'not_base')
  ok('table DDL uses the catalog name, not the request name',
    /"public"\."base"/.test(text) && !/"not_base"/.test(text))
}
await pool.query(`DROP VIEW guard_view`)

console.log('\n== table editor rejects non-tables ==')
{
  const { fetchTableEditState } = await import('../../server/dist/catalog/tableedit.js')
  const threw = async (fn) => { try { await fn(); return null } catch (e) { return e } }
  const partition = await threw(async () => fetchTableEditState(pool, await oidOfRel('list_eu')))
  ok('table editor rejects a partition', partition && partition.statusCode === 400,
    partition ? `${partition.statusCode} ${partition.message}` : 'no error')
  const ordinary = await threw(async () => fetchTableEditState(pool, await oidOfRel('base')))
  ok('table editor accepts an ordinary table', ordinary === null, ordinary?.message)
}

console.log('\n== view and materialized view attributes ==')
await pool.query(`CREATE VIEW view_attrs WITH (security_barrier=true) AS SELECT id, label FROM base`)
await pool.query(`COMMENT ON VIEW view_attrs IS 'a view'`)
await pool.query(`CREATE MATERIALIZED VIEW mv_attrs AS SELECT id FROM base`)
await pool.query(`CREATE INDEX mv_attrs_idx ON mv_attrs (id)`)
await pool.query(`COMMENT ON MATERIALIZED VIEW mv_attrs IS 'a matview'`)
await roundTrip({
  pool, eq, ok, params: ['view_attrs'], create: [], drop: `DROP VIEW view_attrs`,
  label: 'view WITH options and comment',
  fingerprint: `SELECT c.reloptions, obj_description(c.oid) AS comment FROM pg_class c WHERE c.relname=$1`,
  ddl: async () => ddl.viewDdl(pool, await oidOfRel('view_attrs'), 'public', 'view_attrs'),
})
await roundTrip({
  pool, eq, ok, params: ['mv_attrs'], create: [], drop: `DROP MATERIALIZED VIEW mv_attrs`,
  label: 'materialized view with index and comment',
  fingerprint: `SELECT c.reloptions, obj_description(c.oid) AS comment,
    (SELECT string_agg(indexdef, ' ' ORDER BY indexname) FROM pg_indexes
       WHERE schemaname='public' AND tablename=$1) AS idx
    FROM pg_class c WHERE c.relname=$1`,
  ddl: async () => ddl.viewDdl(pool, await oidOfRel('mv_attrs'), 'public', 'mv_attrs'),
})
{
  const viewText = await ddl.viewDdl(pool, await oidOfRel('view_attrs'), 'public', 'view_attrs')
  ok('view keeps WITH options', /WITH \(security_barrier='true'\)|WITH \(security_barrier=true\)/.test(viewText),
    viewText.split('\n').find((l) => /WITH/.test(l))?.trim())
  ok('view keeps its comment', /COMMENT ON VIEW .* IS 'a view'/.test(viewText))
  const mvText = await ddl.viewDdl(pool, await oidOfRel('mv_attrs'), 'public', 'mv_attrs')
  ok('matview keeps its index', /CREATE INDEX .*mv_attrs_idx/.test(mvText))
  ok('matview keeps its comment', /COMMENT ON MATERIALIZED VIEW .* IS 'a matview'/.test(mvText))
}

console.log('\n== foreign table options ==')
await pool.query(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`)
await pool.query(`CREATE SERVER pgdev_fdw_srv FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'localhost', port '5432', dbname 'postgres')`)
await pool.query(`CREATE FOREIGN TABLE foreign_opts (
  id integer OPTIONS (column_name 'remote_id'),
  label text
) SERVER pgdev_fdw_srv OPTIONS (schema_name 'public', table_name 'remote_table')`)
await roundTrip({
  pool, eq, ok, params: ['foreign_opts'], create: [], drop: `DROP FOREIGN TABLE foreign_opts`,
  label: 'foreign table keeps table and column FDW options',
  fingerprint: `SELECT c.relname, s.srvname,
      (SELECT string_agg(o, ',' ORDER BY o) FROM unnest(ft.ftoptions) o) AS topts,
      (SELECT string_agg(a.attname || ':' || array_to_string(a.attfdwoptions, ','), ',' ORDER BY a.attnum)
         FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS copts
    FROM pg_class c JOIN pg_foreign_table ft ON ft.ftrelid=c.oid
    JOIN pg_foreign_server s ON s.oid=ft.ftserver WHERE c.relname=$1`,
  ddl: async () => ddl.tableDdl(pool, await oidOfRel('foreign_opts'), 'public', 'foreign_opts'),
})
{
  const text = await ddl.tableDdl(pool, await oidOfRel('foreign_opts'), 'public', 'foreign_opts')
  ok('emits table-level FDW options', /OPTIONS \(schema_name 'public', table_name 'remote_table'\)/.test(text),
    text.split('\n').find((l) => /schema_name/.test(l))?.trim())
  ok('emits column-level FDW options', /"id" integer OPTIONS \(column_name 'remote_id'\)/.test(text),
    text.split('\n').find((l) => /remote_id/.test(l))?.trim())
}

console.log('\n== sequences ==')
// The identity-section fingerprint plus ownership, for standalone sequences.
const seqOwnedFp = `SELECT format_type(s.seqtypid, NULL) AS type, s.seqstart::text AS start,
    s.seqincrement::text AS inc, s.seqmin::text AS min, s.seqmax::text AS max,
    s.seqcache::text AS cache, s.seqcycle AS cycle,
    (SELECT tn.nspname || '.' || t.relname || '.' || a.attname
       FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE d.objid = c.oid AND d.deptype IN ('a','i')) AS owned
  FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = $1 AND n.nspname = 'public'`
const oidOfSeq = async (name) =>
  (await pool.query(`SELECT c.oid::text AS o FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`, [name])).rows[0]?.o
await roundTrip({
  pool, eq, ok, params: ['seq_plain'], create: `CREATE SEQUENCE seq_plain`,
  drop: `DROP SEQUENCE seq_plain`, label: 'plain default sequence',
  fingerprint: seqOwnedFp,
  ddl: async () => ddl.sequenceDdl(pool, await oidOfSeq('seq_plain'), 'public', 'seq_plain'),
})
await roundTrip({
  pool, eq, ok, params: ['seq_custom'],
  create: `CREATE SEQUENCE seq_custom INCREMENT 10 MINVALUE 50 MAXVALUE 1000 START 500 CACHE 5 CYCLE`,
  drop: `DROP SEQUENCE seq_custom`, label: 'custom sequence options',
  fingerprint: seqOwnedFp,
  ddl: async () => ddl.sequenceDdl(pool, await oidOfSeq('seq_custom'), 'public', 'seq_custom'),
})
await roundTrip({
  pool, eq, ok, params: ['seq_desc'],
  create: `CREATE SEQUENCE seq_desc INCREMENT -1 MAXVALUE 50 MINVALUE 1 START 50`,
  drop: `DROP SEQUENCE seq_desc`, label: 'descending sequence',
  fingerprint: seqOwnedFp,
  ddl: async () => ddl.sequenceDdl(pool, await oidOfSeq('seq_desc'), 'public', 'seq_desc'),
})
await roundTrip({
  pool, eq, ok, params: ['seq_small'],
  create: `CREATE SEQUENCE seq_small AS smallint MINVALUE 5 MAXVALUE 300`,
  drop: `DROP SEQUENCE seq_small`, label: 'smallint sequence keeps its type and bounds',
  fingerprint: seqOwnedFp,
  ddl: async () => ddl.sequenceDdl(pool, await oidOfSeq('seq_small'), 'public', 'seq_small'),
})
// A column-owned sequence: the standalone script carries OWNED BY, so the
// rebuild runs while its table exists (the drop removes only the sequence).
await pool.query(`CREATE TABLE seq_owned_t (id serial)`)
await roundTrip({
  pool, eq, ok, params: ['seq_owned_t_id_seq'],
  create: [], drop: `DROP SEQUENCE seq_owned_t_id_seq CASCADE`,
  label: 'column-owned sequence keeps its ownership',
  fingerprint: seqOwnedFp,
  ddl: async () => ddl.sequenceDdl(pool, await oidOfSeq('seq_owned_t_id_seq'), 'public', 'seq_owned_t_id_seq'),
})
{
  const text = await ddl.sequenceDdl(pool, await oidOfSeq('seq_owned_t_id_seq'), 'public', 'seq_owned_t_id_seq')
  ok('owned sequence emits OWNED BY', /OWNED BY public\.seq_owned_t\.id;/.test(text),
    text.split('\n').find((l) => /OWNED BY/.test(l))?.trim())
  const plain = await ddl.sequenceDdl(pool, await oidOfSeq('seq_plain'), 'public', 'seq_plain')
  const plainLine = (plain.split('\n').find((l) => /CREATE SEQUENCE/.test(l)) ?? '').trim()
  ok('default sequence is bare', plainLine === 'CREATE SEQUENCE "public"."seq_plain" AS bigint;', plainLine)
  const custom = await ddl.sequenceDdl(pool, await oidOfSeq('seq_custom'), 'public', 'seq_custom')
  ok('custom sequence emits its options',
    /CREATE SEQUENCE "public"\."seq_custom" AS bigint MINVALUE 50 MAXVALUE 1000 START WITH 500 INCREMENT BY 10 CACHE 5 CYCLE;/.test(custom),
    custom.split('\n').find((l) => /CREATE SEQUENCE/.test(l))?.trim())
}
await pool.query(`DROP TABLE seq_owned_t CASCADE`)

console.log('\n== metadata harvest still works over this schema ==')
{
  const { fetchSchemaData } = await import('../../server/dist/catalog/metadata.js')
  const schema = await fetchSchemaData(pool)
  ok('harvests every table', schema.tables.length >= 8, `${schema.tables.length} tables`)
  ok('harvests the enum and composite', schema.types.length >= 2, JSON.stringify(schema.types.map((t) => t.name)))
  ok('harvests sequences with details', schema.sequences.length >= 4 &&
    schema.sequences.some((s) => s.name === 'seq_custom' && /inc 10/.test(s.detail)) &&
    schema.sequences.every((s) => s.dataType && s.detail),
    JSON.stringify(schema.sequences.map((s) => `${s.name}: ${s.detail}`)))
  ok('partitions are flagged', schema.tables.filter((t) => t.isPartition).length >= 4)
  ok('partitioned parents are flagged', schema.tables.filter((t) => t.isPartitioned).length >= 2)
  let generated = 0
  const failures = []
  for (const t of schema.tables) {
    try { await ddl.tableDdl(pool, t.oid, t.schema, t.name); generated++ }
    catch (e) { failures.push(`${t.name}: ${e.message}`) }
  }
  eq('every harvested table generates DDL', failures, [])
  ok('generated them all', generated === schema.tables.length, `${generated}/${schema.tables.length}`)
}

// the scratch database (and with it rls_table) is gone by now
for (const r of ROLES) await pool.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
const left = await teardown()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
