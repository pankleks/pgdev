import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { csvEscape, cellToText, formatCellForDisplay, toDelimited } = await load('web/lib/gridio.ts')

test('csvEscape neutralises spreadsheet formula starters', () => {
  // A database value must not execute when the export is opened.
  assert.equal(csvEscape('=cmd|calc'), "'=cmd|calc")
  assert.equal(csvEscape('+1'), "'+1")
  assert.equal(csvEscape('-1'), "'-1")
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvEscape('\t=x'), "'\t=x")
  assert.equal(csvEscape(' =x'), "' =x")
})

test('csvEscape leaves ordinary values alone', () => {
  assert.equal(csvEscape('hello'), 'hello')
  assert.equal(csvEscape(''), '')
  assert.equal(csvEscape('a b c'), 'a b c')
})

test('csvEscape quotes values containing delimiters, quotes or newlines', () => {
  assert.equal(csvEscape('a"b'), '"a""b"')
  assert.equal(csvEscape('a,b'), '"a,b"')
  assert.equal(csvEscape('a\nb'), '"a\nb"')
  assert.equal(csvEscape('a\r\nb'), '"a\r\nb"')
})

test('cellToText renders carriers readably', () => {
  assert.equal(cellToText(null), '')
  assert.equal(cellToText(undefined), '')
  assert.equal(cellToText(0), '0')
  assert.equal(cellToText(false), 'false')
  assert.equal(cellToText({ a: 1 }), '{"a":1}')
  assert.equal(cellToText(new Date('2020-01-02T03:04:05Z')), '2020-01-02T03:04:05.000Z')
})

test('formatCellForDisplay distinguishes NULL from the empty string', () => {
  assert.equal(formatCellForDisplay(null), 'NULL')
  assert.equal(formatCellForDisplay(undefined), 'NULL')
  assert.equal(formatCellForDisplay(''), '')
})

test('toDelimited writes a header row and keeps TSV free of tabs and newlines', () => {
  assert.equal(toDelimited(['a', 'b'], [[1, 2]], ','), 'a,b\n1,2')
  assert.equal(toDelimited(['a'], [[null]], ','), 'a\n')
  // A tab in a value would otherwise shift every later column.
  assert.equal(toDelimited(['a'], [['x\ty']], '\t'), 'a\nx y')
  assert.equal(toDelimited(['a'], [['x\ny']], '\t'), 'a\nx y')
})

test('toDelimited escapes header names too', () => {
  assert.equal(toDelimited(['a,b'], [[1]], ','), '"a,b"\n1')
})
