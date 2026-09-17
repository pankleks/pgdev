// IntelliSense benchmark: a large synthetic schema and script, timed against
// the real modules. Run directly:
//
//   node test/bench/intellisense.mjs
//
// It is not part of `npm test`: timings are environment-dependent, so it prints
// numbers rather than asserting. Use it to compare before/after a change.
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { catalogFor, findCatalogRelation, resolveRelation } = await load('web/lib/catalog.ts')
const { findFunctions } = await load('web/lib/sqlobjects.ts')
const { resolveQueryScope } = await load('web/monaco/sqlscope.ts')
const { findRelation } = await load('web/monaco/sqlrefs.ts')
const { allLexemes } = await load('web/lib/sqlcache.ts')
const { scanSqlLexemes } = await load('server/sqllex.ts')

const SCHEMAS = 50
const TABLES_PER_SCHEMA = 40 // 2000 tables
const COLUMNS = 16
const FUNCTIONS_PER_SCHEMA = 80 // 4000 functions
const BUILTINS = 2000
const STATEMENTS = 2000

function column(name, type = 'text') {
  return { name, type, nullable: true, defaultValue: null }
}

function buildSchema() {
  const tables = []
  const views = []
  const functions = []
  for (let s = 0; s < SCHEMAS; s++) {
    const schema = s === 0 ? 'public' : `s${s}`
    for (let t = 0; t < TABLES_PER_SCHEMA; t++) {
      const columns = []
      for (let c = 0; c < COLUMNS; c++) columns.push(column(`c${c}`, c % 3 === 0 ? 'integer' : 'text'))
      tables.push({
        schema, name: `t_${s}_${t}`, oid: `${s}.${t}`, columns,
        indexes: [], constraints: [], triggers: [],
        isPartition: false, isPartitioned: false, parents: '', relkind: 'r',
      })
    }
    views.push({ schema, name: 'v_all', oid: `v${s}`, materialized: false, columns: [column('c0', 'integer')] })
    for (let f = 0; f < FUNCTIONS_PER_SCHEMA; f++) {
      functions.push({
        schema, name: `fn_${s}_${f}`, args: 'a integer, b text', returns: 'integer',
        typeSig: 'int4', kind: 'function', oid: `${s}.${f}`, arguments: 'a integer, b text', comment: null,
      })
    }
  }
  const builtins = []
  for (let b = 0; b < BUILTINS; b++) {
    builtins.push({
      schema: 'pg_catalog', name: `builtin_${b}`, args: 'value any', returns: 'any',
      typeSig: '', kind: 'function', oid: `b${b}`,
    })
  }
  return { tables, views, functions, types: [], sequences: [], builtins }
}

function buildScript() {
  const lines = []
  for (let i = 0; i < STATEMENTS; i++) {
    lines.push(
      `SELECT c0, c1, c2 FROM s${i % SCHEMAS}.t_${i % SCHEMAS}_${i % TABLES_PER_SCHEMA} WHERE c1 = 'x${i}';`,
    )
  }
  // End on a join-heavy statement so the scope walk has real work.
  const joins = []
  for (let j = 0; j < 20; j++) joins.push(`JOIN s${j}.t_${j}_0 t${j} ON t${j}.c0 = t0.c0`)
  lines.push(`SELECT ${joins.map((_, j) => `t${j}.c1`).join(', ')} FROM s0.t_0_0 t0 ${joins.join(' ')} WHERE `)
  return lines.join('\n')
}

function ms(fn) {
  const start = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - start) / 1e6
}

function perOp(label, iters, fn) {
  for (let i = 0; i < 5; i++) fn()
  const each = ms(() => { for (let i = 0; i < iters; i++) fn() }) / iters
  const ops = each > 0 ? Math.round(1000 / each) : Infinity
  console.log(`${label.padEnd(44)} ${each.toFixed(3).padStart(9)} ms/op   ${String(ops).padStart(8)} ops/s`)
  return each
}

const data = buildSchema()
const script = buildScript()
const aliases = new Map([['t', { schema: 's25', name: 't_25_10' }]])
console.log(`schema: ${data.tables.length} tables, ${data.functions.length} functions, ${data.builtins.length} builtins`)
console.log(`script: ${STATEMENTS + 1} statements, ${(script.length / 1024).toFixed(0)} KiB\n`)

console.log(`catalogFor cold (build index)                ${ms(() => catalogFor(data)).toFixed(2)} ms`)
perOp('catalogFor warm (identity hit)', 200000, () => catalogFor(data))

console.log('')
perOp('allLexemes warm (shared document cache)', 5000, () => allLexemes(script))
perOp('raw scanSqlLexemes (uncached baseline)', 200, () => {
  let n = 0
  scanSqlLexemes(script, () => { n++ })
  return n
})
perOp('resolveQueryScope warm (cached lexemes)', 500, () => resolveQueryScope(script, script.length))

console.log('')
perOp('findFunctions (grouped by name)', 200000, () => findFunctions(data, [], 'fn_25_40'))
perOp('findCatalogRelation (indexed)', 200000, () =>
  findCatalogRelation(catalogFor(data), { schema: 's25', name: 't_25_10' }),
)
perOp('sqlrefs findRelation (linear baseline)', 5000, () =>
  findRelation(catalogFor(data).relations, { schema: 's25', name: 't_25_10' }),
)
perOp('resolveRelation via alias (indexed)', 200000, () =>
  resolveRelation(catalogFor(data), [], ['t'], aliases),
)
