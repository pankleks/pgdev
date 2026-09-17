import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { catalogFor, findCatalogRelation, referenceRelation, resolveRelation, visibleRelations } =
  await load('web/lib/catalog.ts')

const column = (name, type = 'text') => ({ name, type, nullable: true, defaultValue: null })
const table = (schema, name, columns = [column('id', 'integer')]) => ({ schema, name, oid: `${schema}.${name}`, columns })
const view = (schema, name, columns = [column('id', 'integer')]) => ({ schema, name, oid: `v:${schema}.${name}`, columns })
const fn = (schema, name, oid, kind = 'function') => ({
  schema, name, args: '', returns: 'integer', typeSig: 'int4', kind, oid,
})
const data = {
  tables: [table('public', 'items'), table('app', 'thing'), table('audit', 'items')],
  views: [view('public', 'v_items')],
  types: [{ schema: 'public', name: 'mood', oid: 't1', kind: 'enum', detail: '' }],
  sequences: [{ schema: 'public', name: 'item_counter', oid: 's1', dataType: 'integer', detail: '' }],
  functions: [
    fn('public', 'item_count', '10'),
    fn('app', 'item_count', '11'),
    fn('app', 'item_count', '12'),
  ],
  builtins: [fn('pg_catalog', 'round', '20'), fn('pg_catalog', 'round', '21')],
}

test('the catalog is built once per data object', () => {
  assert.equal(catalogFor(data), catalogFor(data))
  assert.notEqual(catalogFor(data), catalogFor({ ...data }))
})

test('qualified lookups are exact and unqualified prefer public', () => {
  const catalog = catalogFor(data)
  assert.equal(findCatalogRelation(catalog, { schema: 'app', name: 'items' }), undefined)
  assert.equal(findCatalogRelation(catalog, { schema: 'app', name: 'thing' }).schema, 'app')
  assert.equal(findCatalogRelation(catalog, { schema: '', name: 'items' }).schema, 'public')
  // A name unique to one non-public schema still resolves.
  assert.equal(findCatalogRelation(catalog, { schema: '', name: 'thing' }).schema, 'app')
  assert.equal(findCatalogRelation(catalog, { schema: '', name: 'missing' }), undefined)
})

test('schemas and per-schema buckets are complete', () => {
  const catalog = catalogFor(data)
  assert.deepEqual(catalog.schemas.sort(), ['app', 'audit', 'public'])
  const app = catalog.bySchema.get('app')
  assert.deepEqual(app.tables.map((t) => t.name), ['thing'])
  assert.deepEqual(app.functions.map((f) => f.oid), ['11', '12'])
  const pub = catalog.bySchema.get('public')
  assert.deepEqual(pub.sequences.map((s) => s.name), ['item_counter'])
  assert.deepEqual(pub.types.map((t) => t.name), ['mood'])
})

test('functions are grouped by name and pre-sorted public-first', () => {
  const catalog = catalogFor(data)
  assert.deepEqual(catalog.functionsByName.get('item_count').map((f) => `${f.schema}:${f.oid}`), [
    'public:10',
    'app:11',
    'app:12',
  ])
  assert.deepEqual(catalog.builtinsByName.get('round').map((f) => f.oid), ['20', '21'])
})

test('synthetic references resolve before the catalog', () => {
  const catalog = catalogFor(data)
  const synthetic = [
    { schema: '', name: '\u00009:recent', label: 'recent', columns: [column('total', '?')] },
  ]
  const ref = { schema: '', name: '\u00009:recent', columns: synthetic[0].columns, label: 'recent' }
  assert.equal(referenceRelation(catalog, synthetic, ref).columns[0].name, 'total')
  // A NUL name never falls through to a catalog relation called `recent`.
  assert.equal(referenceRelation(catalog, synthetic, { schema: '', name: '\u00009:other' }), undefined)
})

test('qualifiers resolve through aliases, schema chains and the fallback', () => {
  const catalog = catalogFor(data)
  const aliases = new Map([
    ['i', { schema: '', name: 'items' }],
    ['t', { schema: 'app', name: 'thing' }],
  ])
  assert.equal(resolveRelation(catalog, [], ['i'], aliases).schema, 'public')
  assert.equal(resolveRelation(catalog, [], ['app', 'thing'], aliases).schema, 'app')
  // A query with sources never falls back to a same-named catalog table.
  assert.equal(resolveRelation(catalog, [], ['v_items'], aliases), undefined)
  // With no FROM, a bare name is still discoverable.
  assert.equal(resolveRelation(catalog, [], ['v_items'], new Map()).name, 'v_items')
})

test('visible relations follow the declared sources, else the whole catalog', () => {
  const catalog = catalogFor(data)
  const scoped = visibleRelations(catalog, [], { hasRelations: true, relations: [], aliases: new Map([['i', { schema: '', name: 'items' }]]) })
  assert.deepEqual(scoped.map((r) => r.name), ['items'])
  const all = visibleRelations(catalog, [], { hasRelations: false, relations: [], aliases: new Map() })
  assert.equal(all.length, catalog.relations.length)
})
