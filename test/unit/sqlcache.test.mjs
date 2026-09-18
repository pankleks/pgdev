import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { allTokens } = await load('web/lib/sqlcache.ts')
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

test('an edited text is re-lexed instead of serving the stale list', () => {
  const text = 'SELECT 1 FROM t'
  const first = allTokens(text)
  assert.equal(allTokens(text), first)
  assert.notEqual(allTokens(`${text} `), first)
})
