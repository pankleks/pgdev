import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { plainSelectTable } = await load('server/selectshape.ts')

// The row editor's safety gate: only a statement this module accepts will
// ever get edit buttons, so a false positive here would mean updating the
// wrong table. Every rejection case below is behaviour, not style.

test('accepts a plain single-table select and resolves its source', () => {
  assert.deepEqual(plainSelectTable('SELECT id, label FROM items'), {
    schema: null,
    table: 'items',
    columns: ['id', 'label'],
  })
  assert.deepEqual(plainSelectTable('select * from public.items'), {
    schema: 'public',
    table: 'items',
    columns: null,
  })
  assert.deepEqual(plainSelectTable('SELECT * FROM items;'), {
    schema: null,
    table: 'items',
    columns: null,
  })
})

test('plain column references may be qualified and repeated', () => {
  assert.deepEqual(plainSelectTable('SELECT t.id, public.items.label FROM items t'), {
    schema: null,
    table: 'items',
    columns: ['id', 'label'],
  })
  assert.deepEqual(plainSelectTable('SELECT t.* FROM items t'), {
    schema: null,
    table: 'items',
    columns: null,
  })
  // Duplicates are accepted here; the runtime PK/duplicate check refuses them.
  assert.deepEqual(plainSelectTable('SELECT id, id FROM items'), {
    schema: null,
    table: 'items',
    columns: ['id', 'id'],
  })
})

test('unquoted names fold, quoted names keep their spelling', () => {
  assert.deepEqual(plainSelectTable('SELECT * FROM MyItems'), {
    schema: null,
    table: 'myitems',
    columns: null,
  })
  assert.deepEqual(plainSelectTable('SELECT * FROM "MyItems"'), {
    schema: null,
    table: 'MyItems',
    columns: null,
  })
  assert.deepEqual(plainSelectTable('SELECT * FROM "My Schema"."My Table"'), {
    schema: 'My Schema',
    table: 'My Table',
    columns: null,
  })
})

test('table aliases are fine, with or without AS', () => {
  assert.deepEqual(plainSelectTable('SELECT * FROM items i WHERE i.id > 1'), {
    schema: null,
    table: 'items',
    columns: null,
  })
  assert.deepEqual(plainSelectTable('SELECT * FROM public.items AS it ORDER BY it.id'), {
    schema: 'public',
    table: 'items',
    columns: null,
  })
})

test('trailing clauses that keep row identity are accepted', () => {
  const sql = 'SELECT id FROM items WHERE label IS NOT NULL ORDER BY id DESC LIMIT 10 OFFSET 5'
  assert.deepEqual(plainSelectTable(sql), { schema: null, table: 'items', columns: ['id'] })
  assert.deepEqual(plainSelectTable('SELECT id FROM items FETCH FIRST 5 ROWS ONLY'), {
    schema: null,
    table: 'items',
    columns: ['id'],
  })
})

test('keywords inside strings, comments and identifiers do not count', () => {
  assert.deepEqual(plainSelectTable('SELECT id -- from other\nFROM items'), {
    schema: null,
    table: 'items',
    columns: ['id'],
  })
  assert.deepEqual(plainSelectTable('SELECT id /* join union */ FROM items'), {
    schema: null,
    table: 'items',
    columns: ['id'],
  })
  assert.deepEqual(plainSelectTable('SELECT "from" FROM items'), {
    schema: null,
    table: 'items',
    columns: ['from'],
  })
  assert.deepEqual(plainSelectTable('SELECT id FROM items i WHERE i.name = ANY($tag$join$tag$)'), {
    schema: null,
    table: 'items',
    columns: ['id'],
  })
})

test('functions named left/right in WHERE stay accepted', () => {
  assert.deepEqual(plainSelectTable("SELECT id FROM items WHERE left(label, 1) = 'a'"), {
    schema: null,
    table: 'items',
    columns: ['id'],
  })
})

test('select-list expressions, casts and aliases are rejected', () => {
  // An expression aliased to a real column name would send a value that no
  // longer identifies the row it came from, so the whole statement is out.
  assert.equal(plainSelectTable('SELECT id + 1 AS id, label FROM items'), null)
  assert.equal(plainSelectTable('SELECT upper(label) FROM items'), null)
  assert.equal(plainSelectTable('SELECT id::text FROM items'), null)
  assert.equal(plainSelectTable('SELECT id AS ident FROM items'), null)
  assert.equal(plainSelectTable('SELECT (SELECT max(x) FROM other) AS m FROM items'), null)
  assert.equal(plainSelectTable("SELECT 'from items join' AS note FROM items"), null)
  assert.equal(plainSelectTable("SELECT count(*) FROM items"), null)
})

test('joins, set operations and grouping are rejected', () => {
  assert.equal(plainSelectTable('SELECT * FROM items i JOIN other o ON o.id = i.id'), null)
  assert.equal(plainSelectTable('SELECT * FROM items i LEFT JOIN other o ON o.id = i.id'), null)
  assert.equal(plainSelectTable('SELECT * FROM items CROSS JOIN other'), null)
  assert.equal(plainSelectTable('SELECT * FROM items, other'), null)
  assert.equal(plainSelectTable('SELECT * FROM items UNION SELECT * FROM other'), null)
  assert.equal(plainSelectTable('SELECT id FROM items GROUP BY id'), null)
  assert.equal(plainSelectTable('SELECT id FROM items WHERE id > 1 GROUP BY id'), null)
  assert.equal(plainSelectTable('SELECT id FROM items HAVING count(*) > 1'), null)
  assert.equal(plainSelectTable('SELECT DISTINCT id FROM items'), null)
})

test('CTEs, subqueries and functions in FROM are rejected', () => {
  assert.equal(plainSelectTable('WITH x AS (SELECT 1) SELECT * FROM x'), null)
  assert.equal(plainSelectTable('SELECT * FROM (SELECT * FROM items) x'), null)
  assert.equal(plainSelectTable('SELECT * FROM generate_series(1, 2)'), null)
  assert.equal(plainSelectTable('SELECT * FROM public.generate_series(1, 2)'), null)
})

test('statements without a table identity are rejected', () => {
  assert.equal(plainSelectTable('SELECT 1'), null)
  assert.equal(plainSelectTable('UPDATE items SET label = 1'), null)
  assert.equal(plainSelectTable(''), null)
  assert.equal(plainSelectTable('SELECT * FROM items FOR UPDATE'), null)
  assert.equal(plainSelectTable('SELECT * FROM ONLY items'), null)
  assert.equal(plainSelectTable('SELECT id INTO new_items FROM items'), null)
  assert.equal(plainSelectTable('SELECT * FROM items TABLESAMPLE SYSTEM (1)'), null)
})
