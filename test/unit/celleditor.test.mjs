import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const {
  editorKind, isArrayType, isMultiDimensionalArray, isReadOnlyType, jsonSyntaxError,
  numberStep, fromEditorValue, toBool, toEditorValue, usesTextarea,
} = await load('web/lib/celleditor.ts')

// The row dialog picks a control from the column type and converts the
// PostgreSQL text into what that control needs; the conversions must be
// exact, because SAVE sends the control text straight back as a parameter.

test('column types map onto their editor kind', () => {
  assert.equal(editorKind('boolean'), 'boolean')
  assert.equal(editorKind('smallint'), 'number')
  assert.equal(editorKind('integer'), 'number')
  assert.equal(editorKind('bigint'), 'number')
  assert.equal(editorKind('numeric'), 'number')
  assert.equal(editorKind('numeric(10,2)'), 'number')
  assert.equal(editorKind('real'), 'number')
  assert.equal(editorKind('double precision'), 'number')
  assert.equal(editorKind('money'), 'text')
  assert.equal(editorKind('date'), 'date')
  assert.equal(editorKind('time without time zone'), 'time')
  assert.equal(editorKind('time with time zone'), 'text')
  assert.equal(editorKind('timestamp without time zone'), 'datetime')
  assert.equal(editorKind('timestamp with time zone'), 'datetime')
  assert.equal(editorKind('json'), 'json')
  assert.equal(editorKind('jsonb'), 'json')
  assert.equal(editorKind('uuid'), 'text')
  assert.equal(editorKind('integer[]'), 'text')
})

test('numeric steps and binary read-only detection', () => {
  assert.equal(numberStep('integer'), '1')
  assert.equal(numberStep('bigint'), '1')
  assert.equal(numberStep('numeric'), 'any')
  assert.equal(numberStep('double precision'), 'any')
  assert.equal(isReadOnlyType('bytea'), true)
  assert.equal(isReadOnlyType('text'), false)
})

test('array types are recognised, and nested literals are locked', () => {
  assert.equal(isArrayType('integer[]'), true)
  assert.equal(isArrayType('character varying[]'), true)
  assert.equal(isArrayType('integer'), false)
  assert.equal(isMultiDimensionalArray('{1,2,3}'), false)
  assert.equal(isMultiDimensionalArray('{}'), false)
  assert.equal(isMultiDimensionalArray('{NULL,"a b"}'), false)
  // A brace inside a quoted element is data, not a dimension.
  assert.equal(isMultiDimensionalArray('{"{x}",y}'), false)
  assert.equal(isMultiDimensionalArray('{{1,2},{3,4}}'), true)
  assert.equal(isMultiDimensionalArray('{{}}'), true)
  assert.equal(isMultiDimensionalArray('not an array'), false)
})

test('only text and JSON/JSONB get a textarea', () => {
  assert.equal(usesTextarea('text'), true)
  assert.equal(usesTextarea('json'), true)
  assert.equal(usesTextarea('jsonb'), true)
  assert.equal(usesTextarea('character varying'), false)
  assert.equal(usesTextarea('character varying(50)'), false)
  assert.equal(usesTextarea('varchar'), false)
  assert.equal(usesTextarea('character'), false)
  assert.equal(usesTextarea('uuid'), false)
  assert.equal(usesTextarea('money'), false)
  assert.equal(usesTextarea('text[]'), false)
})

test('json controls get the token-safe pretty reprint', () => {
  assert.equal(toEditorValue('{"a":1}', 'jsonb'), '{\n  "a": 1\n}')
  assert.equal(toEditorValue('[1,true]', 'json'), '[\n  1,\n  true\n]')
})

test('timestamps without a zone swap the space for the T separator', () => {
  assert.equal(
    toEditorValue('2024-01-15 10:30:00', 'timestamp without time zone'),
    '2024-01-15T10:30:00',
  )
  assert.equal(
    toEditorValue('2024-01-15 10:30:00.123', 'timestamp without time zone'),
    '2024-01-15T10:30:00.123',
  )
})

test('sub-millisecond digits are truncated for native controls', () => {
  // PostgreSQL prints microseconds; the HTML control value accepts at most
  // three fractional digits, and more make it invalid (renders empty).
  assert.equal(
    toEditorValue('2025-12-05 17:18:31.422123', 'timestamp without time zone'),
    '2025-12-05T17:18:31.422',
  )
  assert.equal(
    toEditorValue('17:18:31.422123', 'time without time zone'),
    '17:18:31.422',
  )
  assert.equal(toEditorValue('2025-12-05 17:18:31', 'timestamp without time zone'), '2025-12-05T17:18:31')
})

test('date and time pass through unchanged', () => {
  assert.equal(toEditorValue('2024-01-15', 'date'), '2024-01-15')
  assert.equal(toEditorValue('10:30:00', 'time without time zone'), '10:30:00')
})

test('timestamptz is shown in the browser wall clock', () => {
  // The control carries no offset, so assert the instant survives when the
  // same wall time is parsed back in this process's timezone.
  for (const raw of [
    '2024-01-15 10:30:00+00',
    '2024-01-15 16:00:00+05:30',
    '2024-01-15 05:30:00-05',
    '2024-01-15 10:30:00.123+00',
  ]) {
    const control = toEditorValue(raw, 'timestamp with time zone')
    assert.match(control, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/)
    // PostgreSQL may print `+00` where ISO requires `+00:00`.
    const iso = raw.replace(' ', 'T').replace(/[+-]\d{2}$/, '$&:00')
    assert.equal(new Date(control).getTime(), new Date(iso).getTime())
  }
})

test('unparsable temporal text falls back to the raw value', () => {
  assert.equal(toEditorValue('infinity', 'date'), 'infinity')
  assert.equal(toEditorValue('infinity', 'timestamp with time zone'), 'infinity')
})

test('the control text is sent back unchanged, and booleans normalise', () => {
  assert.equal(fromEditorValue('2024-01-15T10:30:00'), '2024-01-15T10:30:00')
  assert.equal(fromEditorValue('2024-01-15T10:30:00', 'timestamp without time zone'), '2024-01-15T10:30:00')
  assert.equal(toBool(true), true)
  assert.equal(toBool('true'), true)
  assert.equal(toBool(false), false)
  assert.equal(toBool(null), false)
})

test('edited timestamptz keeps its instant via the browser offset', () => {
  // toEditorValue shows the instant as a wall time without an offset; sending
  // that wall time back bare would reinterpret it in the database timezone.
  for (const raw of [
    '2024-01-15 10:30:00+00',
    '2024-01-15 16:00:00+05:30',
    '2024-01-15 05:30:00-05',
    '2024-06-01 12:00:00+00',
    '2024-01-15 10:30:00.123+00',
  ]) {
    const control = toEditorValue(raw, 'timestamp with time zone')
    const sent = fromEditorValue(control, 'timestamp with time zone')
    assert.match(sent, /[+-]\d{2}:\d{2}$/, `${raw} -> ${control} -> ${sent}`)
    const iso = raw.replace(' ', 'T').replace(/[+-]\d{2}$/, '$&:00')
    assert.equal(new Date(sent).getTime(), new Date(iso).getTime(), raw)
  }
  // Already-offset values, other types and garbage pass through untouched.
  assert.equal(
    fromEditorValue('2024-01-15T10:30:00+02:00', 'timestamp with time zone'),
    '2024-01-15T10:30:00+02:00',
  )
  assert.equal(fromEditorValue('not a date', 'timestamp with time zone'), 'not a date')
})

// The DST-overlap behavior depends on the process timezone, so the pinned
// cases run in a child with TZ fixed at Europe/Warsaw (its autumn transition
// repeats a local hour: 03:00+02 == 02:00+01 on 2024-10-27).
// The probe path derives from this file's location, not process.cwd():
// `npm test` runs node --test with cwd=test/, and a cwd-built path would
// land at test/web/… which does not exist.
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/+$/, '')
const tzProbe = `
  import { registerHooks } from 'node:module';
  registerHooks({ resolve(s, c, n) {
    if (c.parentURL?.includes('/src/') && s.startsWith('.')) {
      return { url: new URL(s.endsWith('.js') ? s.slice(0, -3) + '.ts' : s.endsWith('.ts') ? s : s + '.ts', c.parentURL).href, shortCircuit: true };
    }
    return n(s, c);
  } });
  const { toEditorValue, fromEditorValue } = await import('file:///${REPO}/web/src/lib/celleditor.ts');
  const instant = (raw) => new Date(raw.replace(' ', 'T').replace(/[+-][0-9][0-9]$/, (m) => m + ':00')).getTime();
  const out = [];
  for (const raw of [
    '2024-10-27 01:30:00+00',   // wall 02:30, ambiguous (+01/+02)
    '2025-10-26 01:30:00+00',   // wall 02:30, ambiguous (+01/+02)
    '2024-10-27 00:30:00+00',   // wall 01:30, before the transition
    '2024-03-31 02:30:00+00',   // spring-forward gap: displays 04:30
    '2024-01-15 10:30:00+00',   // ordinary winter time
  ]) {
    const control = toEditorValue(raw, 'timestamp with time zone');
    const sent = fromEditorValue(control, 'timestamp with time zone', raw);
    out.push({ raw, control, sent, original: instant(raw), reparsed: new Date(sent).getTime() });
  }
  console.log(JSON.stringify(out));
`

test('edited timestamptz keeps its instant through a DST overlap (pinned TZ)', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', tzProbe], {
    env: { ...process.env, TZ: 'Europe/Warsaw' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const rows = JSON.parse(result.stdout)
  for (const { raw, control, sent, original, reparsed } of rows) {
    assert.match(control, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `${raw} -> ${control}`)
    assert.match(sent, /[+-]\d{2}:\d{2}$/, `${raw} -> ${sent}`)
    assert.equal(reparsed, original, `${raw} -> ${control} -> ${sent}`)
  }
  // The overlap case must resolve to the side the user was actually viewing
  // (the second pass, +01) rather than the engine's first-occurrence choice.
  const overlap = rows[0]
  assert.equal(overlap.sent, '2024-10-27T02:30:00+01:00', overlap.sent)
})

test('edited JSON is syntax-checked without rewriting it', () => {
  // Valid documents and scalars pass; the parsed value is discarded, so
  // large integers and number spellings are untouched by the check.
  for (const text of ['{}', '[]', '{"a":1}', '[1, true, null, "x"]', '"abc"', '1.0', 'null', '9007199254740993']) {
    assert.equal(jsonSyntaxError(text), null, text)
  }
  // Malformed or empty text is rejected with a parse message.
  assert.match(jsonSyntaxError('{oops'), /JSON/)
  assert.match(jsonSyntaxError('{"a":}'), /JSON/)
  assert.match(jsonSyntaxError(''), /JSON/)
  assert.match(jsonSyntaxError('{"a":1} trailing'), /JSON/)
})
