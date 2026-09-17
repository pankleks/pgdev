import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { allLexemes, allTokens } = await load('web/lib/sqlcache.ts')
const sqllex = await load('server/sqllex.ts')
const { scanSqlLexemes } = sqllex

test('allTokens contains exactly the identifier and punctuation lexemes', () => {
  const text = "SELECT a.x, 'lit' /* c */ FROM t WHERE \"My Col\" = 1 -- end"
  const expected = []
  scanSqlLexemes(text, (lex) => {
    if (lex.kind === 'ident' || lex.kind === 'punct') {
      expected.push({ kind: lex.kind, start: lex.start, end: lex.end, raw: lex.raw, name: lex.name, quoted: lex.quoted })
    }
  })
  assert.deepEqual(allTokens(text), expected)
  // Quoted identifiers keep their raw text and expose the unquoted name.
  const quoted = allTokens(text).find((t) => t.quoted)
  assert.equal(quoted.raw, '"My Col"')
  assert.equal(quoted.name, 'My Col')
})

test('the lexeme and token lists are memoized by content', () => {
  const text = 'SELECT 1 FROM t'
  assert.equal(allLexemes(text), allLexemes(text))
  assert.equal(allTokens(text), allTokens(text))
  // A different text is a different list.
  assert.notEqual(allTokens(text), allTokens(`${text} `))
})

test('an unchanged text hits the cache across calls', () => {
  const first = allTokens('SELECT id FROM items')
  const again = allTokens('SELECT id FROM items')
  assert.equal(first, again)
})
