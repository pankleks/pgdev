import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { escapeMarkdown, formatColumnHover, formatFunctionHover } = await load('web/lib/hovertext.ts')

const fn = (over = {}) => ({
  schema: 'public',
  name: 'label',
  args: 'integer',
  returns: 'integer',
  typeSig: 'int4',
  kind: 'function',
  oid: '1',
  arguments: 'p integer',
  comment: null,
  ...over,
})

test('function hover shows signature, kind, schema and comment', () => {
  assert.equal(
    formatFunctionHover([fn({ comment: 'Echoes the given id.' })]),
    '**label**(p integer) → integer\n_function · public_\n\nEchoes the given id.',
  )
})

test('built-ins use identity arguments and their comment', () => {
  const markdown = formatFunctionHover([
    fn({
      schema: 'pg_catalog',
      name: 'jsonb_build_object',
      args: 'VARIADIC "any"',
      returns: 'jsonb',
      arguments: undefined,
      comment: 'Builds a JSON object.',
    }),
  ])
  assert.match(markdown, /\*\*jsonb_build_object\*\*\(VARIADIC "any"\) → jsonb/)
  assert.match(markdown, /_function · pg_catalog_/)
  assert.match(markdown, /Builds a JSON object\./)
})

test('procedures have no result arrow', () => {
  assert.equal(
    formatFunctionHover([
      fn({ kind: 'procedure', name: 'do_thing', args: 'p_id integer', arguments: 'p_id integer', returns: '' }),
    ]),
    '**do_thing**(p_id integer)\n_procedure · public_',
  )
})

test('aggregate and window markers survive', () => {
  assert.match(formatFunctionHover([fn({ kind: 'aggregate' })]), /_aggregate · public_/)
  assert.match(formatFunctionHover([fn({ kind: 'window' })]), /_window · public_/)
})

test('overloads are capped with a remainder line', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    fn({ oid: String(i), args: `a${i} integer`, arguments: `a${i} integer` }),
  )
  const markdown = formatFunctionHover(many)
  assert.equal(markdown.match(/\*\*label\*\*/g)?.length, 5)
  assert.match(markdown, /_\+2 more overload\(s\)_/)
})

test('comment text is markdown-escaped', () => {
  const markdown = formatFunctionHover([fn({ comment: 'Uses *stars* and _under_scores_ [brackets] `ticks`' })])
  assert.match(markdown, /Uses \\\*stars\\\* and \\_under\\_scores\\_ \\\[brackets\\\] \\`ticks\\`/)
})

test('markdown escaping covers the control characters', () => {
  assert.equal(escapeMarkdown('a*b_c[d]`e\\f'), 'a\\*b\\_c\\[d\\]\\`e\\\\f')
})

test('columns show type, relation, nullability and default', () => {
  assert.equal(
    formatColumnHover({ name: 'label', type: 'text', relation: 'public.items', nullable: false, defaultValue: null }),
    '**label**\n_text · public.items · not null_',
  )
  assert.equal(
    formatColumnHover({ name: 'qty', type: 'numeric', relation: 'public.items', nullable: true, defaultValue: '0' }),
    '**qty**\n_numeric · public.items_\n\ndefault 0',
  )
})
