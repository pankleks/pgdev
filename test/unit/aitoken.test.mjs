import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { defaultTokenPath, ephemeralToken, loadOrCreateToken } = await load('server/ai/token.ts')

// The stable agent token: generated once, persisted, rotated by deleting.

function scratch() {
  return mkdtempSync(join(tmpdir(), 'pgdev-aitoken-'))
}

test('a fresh file gets a token that survives a second boot', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'token')
  const first = loadOrCreateToken(file)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(loadOrCreateToken(file), first)
  assert.equal(readFileSync(file, 'utf8').trim(), first)
})

test('an existing token is used as-is', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'token')
  writeFileSync(file, '  abcdef0123456789abcdef0123456789  \n')
  assert.equal(loadOrCreateToken(file), 'abcdef0123456789abcdef0123456789')
})

test('malformed content is replaced, not kept', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'token')
  writeFileSync(file, 'not-a-token')
  const token = loadOrCreateToken(file)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.notEqual(token, 'not-a-token')
})

test('an unwritable path degrades to an ephemeral token', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A regular file where a directory is needed: mkdirSync fails.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const token = loadOrCreateToken(join(blocker, 'token'))
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(ephemeralToken().length, 64)
})

test('the token file is owner-only on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'nested', 'token')
  loadOrCreateToken(file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700)
})

test('the default path lives in the user config dir', () => {
  assert.ok(defaultTokenPath().endsWith(join('.config', 'pgdev', 'token')), defaultTokenPath())
})
