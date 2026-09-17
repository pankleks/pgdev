import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { parseFunctionArgs, argumentText } = await load('web/lib/functionargs.ts')

test('named arguments carry name, type and in-mode', () => {
  const args = parseFunctionArgs('a integer, b text')
  assert.deepEqual(
    args.map((a) => ({ name: a.name, type: a.type, mode: a.mode })),
    [
      { name: 'a', type: 'integer', mode: 'in' },
      { name: 'b', type: 'text', mode: 'in' },
    ],
  )
})

test('argument modes are recognised, including two-word IN OUT', () => {
  const args = parseFunctionArgs('IN a integer, OUT b text, INOUT c int, IN OUT d int, VARIADIC e int[]')
  assert.deepEqual(args.map((a) => a.mode), ['in', 'out', 'inout', 'inout', 'variadic'])
  assert.deepEqual(args.map((a) => a.name), ['a', 'b', 'c', 'd', 'e'])
})

test('defaults are stripped from the type', () => {
  const [a] = parseFunctionArgs('p integer DEFAULT 1')
  assert.equal(a.name, 'p')
  assert.equal(a.type, 'integer')
})

test('multi-word types are not mistaken for names', () => {
  const args = parseFunctionArgs('double precision, character varying(10), timestamp with time zone')
  assert.deepEqual(args.map((a) => a.name), [undefined, undefined, undefined])
  assert.deepEqual(args.map((a) => a.type), ['double precision', 'character varying(10)', 'timestamp with time zone'])
})

test('a named parameter with a multi-word type keeps its name', () => {
  const [a] = parseFunctionArgs('created_at timestamp with time zone')
  assert.equal(a.name, 'created_at')
  assert.equal(a.type, 'timestamp with time zone')
})

test('identity-only arguments (builtins) expose no name', () => {
  const args = parseFunctionArgs('VARIADIC "any"')
  assert.equal(args.length, 1)
  assert.equal(args[0].name, undefined)
  assert.equal(args[0].mode, 'variadic')
  assert.equal(args[0].type, '"any"')
})

test('commas inside types and defaults do not split arguments', () => {
  const args = parseFunctionArgs("numeric(10, 2), label text DEFAULT 'a,b'")
  assert.equal(args.length, 2)
  assert.equal(args[0].type, 'numeric(10, 2)')
  assert.equal(args[1].name, 'label')
  assert.equal(args[1].type, 'text')
})

test('quoted parameter names are recognised', () => {
  const [a] = parseFunctionArgs('"from" integer')
  assert.equal(a.name, '"from"')
  assert.equal(a.type, 'integer')
})

test('quoted and schema-qualified types stay types', () => {
  const args = parseFunctionArgs('"MyType"[], myschema.mytype')
  assert.equal(args[0].name, undefined)
  assert.equal(args[0].type, '"MyType"[]')
  assert.equal(args[1].name, undefined)
  assert.equal(args[1].type, 'myschema.mytype')
})

test('parameter labels point at the name when named, else the type', () => {
  const text = 'a integer, double precision'
  const args = parseFunctionArgs(text)
  assert.equal(text.slice(args[0].labelStart, args[0].labelEnd), 'a')
  assert.equal(text.slice(args[1].labelStart, args[1].labelEnd), 'double precision')
})

test('empty argument text yields no parameters', () => {
  assert.deepEqual(parseFunctionArgs(''), [])
})

test('argumentText prefers the named form, falling back to identity', () => {
  const base = { schema: 'public', name: 'f', args: 'integer', returns: '', typeSig: '', kind: 'function', oid: '1' }
  assert.equal(argumentText({ ...base, arguments: 'p integer' }), 'p integer')
  assert.equal(argumentText(base), 'integer')
})
