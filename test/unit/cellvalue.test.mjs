import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { formatCellValue } = await load('web/lib/cellvalue.ts')

// The value dialog decides per column type whether to pretty-print JSON, so
// these are behaviour: a mangled reprint would corrupt what the user copies.

test('jsonb objects reprint with a two-space indent', () => {
  assert.equal(
    formatCellValue('{"a":1,"b":{"c":[1,2]},"d":null}', 'jsonb'),
    '{\n  "a": 1,\n  "b": {\n    "c": [\n      1,\n      2\n    ]\n  },\n  "d": null\n}',
  )
})

test('json nested arrays pretty-print too', () => {
  assert.equal(formatCellValue('[{"x":1},{"y":"z"}]', 'json'), '[\n  {\n    "x": 1\n  },\n  {\n    "y": "z"\n  }\n]')
})

test('json scalars survive the round trip', () => {
  assert.equal(formatCellValue('"quoted"', 'json'), '"quoted"')
  assert.equal(formatCellValue('7', 'jsonb'), '7')
  assert.equal(formatCellValue('true', 'jsonb'), 'true')
})

test('invalid or empty JSON text falls back to the raw value', () => {
  assert.equal(formatCellValue('{"a":1,,}', 'jsonb'), '{"a":1,,}')
  assert.equal(formatCellValue('', 'jsonb'), '')
  assert.equal(formatCellValue('   ', 'json'), '   ')
})

test('non-JSON types pass the value through verbatim', () => {
  assert.equal(formatCellValue('{"looks":"like json"}', 'text'), '{"looks":"like json"}')
  assert.equal(formatCellValue('plain', 'integer'), 'plain')
})

test('jsonb null text prints as null, not the empty string', () => {
  assert.equal(formatCellValue('null', 'jsonb'), 'null')
})
