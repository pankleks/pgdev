import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { parseConnectNumber, assignSeqs, maxSeq } = await load('web/lib/connectionref.ts')

test('only a positive integer connect parameter is accepted', () => {
  assert.equal(parseConnectNumber('?connect=1'), 1)
  assert.equal(parseConnectNumber('?connect=42'), 42)
  assert.equal(parseConnectNumber('?foo=1&connect=3'), 3)
  assert.equal(parseConnectNumber(''), null)
  assert.equal(parseConnectNumber('?connect='), null)
  assert.equal(parseConnectNumber('?connect=0'), null)
  assert.equal(parseConnectNumber('?connect=-2'), null)
  assert.equal(parseConnectNumber('?connect=2.5'), null)
  assert.equal(parseConnectNumber('?connect=abc'), null)
  assert.equal(parseConnectNumber('?other=1'), null)
})

test('legacy saved entries are numbered in order', () => {
  const entries = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
  assignSeqs(entries)
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3])
})

test('existing numbers are preserved and new ones continue above the maximum', () => {
  const entries = [{ label: 'a', seq: 5 }, { label: 'b', seq: 2 }, { label: 'c' }]
  assignSeqs(entries)
  assert.equal(entries[0].seq, 5)
  assert.equal(entries[1].seq, 2)
  assert.equal(entries[2].seq, 6)
})

test('invalid numbers are replaced and never overwrite a valid one', () => {
  const entries = [{ seq: 0 }, { seq: -1 }, { seq: 'x' }, { seq: 3 }]
  assignSeqs(entries)
  assert.deepEqual(entries.map((e) => e.seq), [4, 5, 6, 3])
})

test('the high-water mark ignores absent and invalid numbers', () => {
  assert.equal(maxSeq([]), 0)
  assert.equal(maxSeq([{ seq: 2 }, { seq: 7 }, { seq: 'x' }, {}]), 7)
})
