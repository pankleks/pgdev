import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { scanSqlLexemes } = await load('server/sqllex.ts')

function lexemes(sql) {
  const out = []
  scanSqlLexemes(sql, (lex) => {
    out.push(lex)
  })
  return out
}

// The shared scanner feeds the statement splitter, the query router, the
// agent's read-only gate and the browser's hover/completion context, so its
// spans and names are the contract they all rely on.

test('lexemes classify every construct with exact spans', () => {
  const sql = "SELECT a, \"B\"\"c\", E'x''y', $$;$$ /* ; */ FROM t"
  assert.deepEqual(
    lexemes(sql).map((l) => l.kind),
    [
      'ident', 'whitespace', 'ident', 'punct', 'whitespace', 'ident', 'punct',
      'whitespace', 'ident', 'string', 'punct', 'whitespace', 'dollar',
      'whitespace', 'blockComment', 'whitespace', 'ident', 'whitespace', 'ident',
    ],
  )
  assert.deepEqual(lexemes(sql).map((l) => l.raw), [
    'SELECT', ' ', 'a', ',', ' ', '"B""c"', ',', ' ', 'E', "'x''y'", ',', ' ',
    '$$;$$', ' ', '/* ; */', ' ', 'FROM', ' ', 't',
  ])
  const quoted = lexemes(sql).find((l) => l.quoted)
  assert.deepEqual(
    quoted && { raw: quoted.raw, name: quoted.name },
    { raw: '"B""c"', name: 'B"c' },
  )
  // A string lexeme starts at the quote; the E prefix is its own ident.
  const str = lexemes("E'x''y'").find((l) => l.kind === 'string')
  assert.deepEqual(
    str && { raw: str.raw, name: str.name },
    { raw: "'x''y'", name: "x''y" },
  )
})

test('nested block comments scan as one span', () => {
  const comments = lexemes('/* a /* b ; */ c */ SELECT 1').filter((l) => l.kind === 'blockComment')
  assert.equal(comments.length, 1)
  assert.equal(comments[0].raw, '/* a /* b ; */ c */')
})

test('dollar bodies run to the matching tag and never split on their semicolons', () => {
  const dollar = lexemes('DO $tag$ BEGIN; END $tag$; SELECT 1').find((l) => l.kind === 'dollar')
  assert.equal(dollar.raw, '$tag$ BEGIN; END $tag$')
})

test('line comments stop before the newline, which stays whitespace', () => {
  const found = lexemes('SELECT 1 -- ;\n, 2')
  const comment = found.find((l) => l.kind === 'lineComment')
  assert.equal(comment.raw, '-- ;')
  const after = found[found.length - 1]
  assert.deepEqual([after.kind, after.raw], ['punct', '2'])
})

test('the visitor can stop early', () => {
  const seen = []
  scanSqlLexemes('SELECT 1 FROM t', (lex) => {
    if (seen.push(lex) === 3) return false
  })
  assert.deepEqual(seen.map((l) => l.kind), ['ident', 'whitespace', 'punct'])
})
