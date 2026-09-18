import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { formatCellValue } = await load('web/lib/cellvalue.ts')

// The value dialog decides per column type whether to pretty-print JSON, so
// these are behaviour: a mangled reprint would corrupt what the user copies.

test('json objects, arrays and escapes reprint without touching tokens', () => {
  assert.equal(
    formatCellValue('{"a":1,"b":{"c":[1,2]},"d":null}', 'jsonb'),
    '{\n  "a": 1,\n  "b": {\n    "c": [\n      1,\n      2\n    ]\n  },\n  "d": null\n}',
  )
  // JSON.parse + JSON.stringify would turn 9007199254740993 into
  // 9007199254740992 and 1.0 into 1 — the formatter must only move tokens.
  assert.equal(
    formatCellValue('{"id":9007199254740993,"small":1.0,"e":1e999,"neg":-0.50}', 'jsonb'),
    '{\n  "id": 9007199254740993,\n  "small": 1.0,\n  "e": 1e999,\n  "neg": -0.50\n}',
  )
  assert.equal(formatCellValue('"a\\"b\\\\c\\u0041"', 'jsonb'), '"a\\"b\\\\c\\u0041"')
  assert.equal(
    formatCellValue('[{"k":"line\\ntext"}]', 'json'),
    '[\n  {\n    "k": "line\\ntext"\n  }\n]',
  )
  assert.equal(formatCellValue('{ "a" : 1 , "b" : [ ] }', 'jsonb'), '{\n  "a": 1,\n  "b": []\n}')
  assert.equal(formatCellValue('[{"x":1},{"y":"z"}]', 'json'), '[\n  {\n    "x": 1\n  },\n  {\n    "y": "z"\n  }\n]')
})

test('scalars, invalid text and null fall back safely', () => {
  assert.equal(formatCellValue('"quoted"', 'json'), '"quoted"')
  assert.equal(formatCellValue('7', 'jsonb'), '7')
  assert.equal(formatCellValue('true', 'jsonb'), 'true')
  assert.equal(formatCellValue('null', 'jsonb'), 'null')
  assert.equal(formatCellValue('{"a":1,,}', 'jsonb'), '{"a":1,,}')
  assert.equal(formatCellValue('', 'jsonb'), '')
  assert.equal(formatCellValue('   ', 'json'), '   ')
})

test('non-JSON types pass the value through verbatim', () => {
  assert.equal(formatCellValue('{"looks":"like json"}', 'text'), '{"looks":"like json"}')
  assert.equal(formatCellValue('plain', 'integer'), 'plain')
})
