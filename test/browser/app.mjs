// Browser end-to-end checks over the DevTools Protocol — no dependencies.
//
// Starts the real server and the Vite dev server against a scratch database,
// then drives Chrome. Opt-in: set PGDEV_TEST_URL and PGDEV_BROWSER=1, because
// it needs the dev stack and a Chrome binary.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentials, scratchDatabase, counters } from '../lib/db.mjs'
import { launchChrome, openPage, findChrome } from '../lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
// Must match the pair the origin guard allows (see allowedOrigin in
// server/src/app.ts): the Vite dev proxy is the one cross-port exception.
const API_PORT = 3010
const WEB_PORT = 5173

if (!existsSync(join(REPO, 'web', 'dist'))) {
  console.log('web/dist is missing; run npm run build first')
  process.exit(2)
}
const base = await credentials()
// launchChrome honors CHROME_PATH; the fallback list only covers Mac/Linux.
// credentials() must run first — it is what loads .env, where CHROME_PATH lives.
if (!process.env.CHROME_PATH && !findChrome()) {
  console.log('no Chrome binary found; set CHROME_PATH to run the browser suite')
  process.exit(2)
}
const DB = `pgdev_browsertest_${process.pid}`
const { pool, teardown } = await scratchDatabase(base, DB)
const { eq, ok, report } = counters()

await pool.query(`
  CREATE TABLE items (
    id serial PRIMARY KEY,
    label text NOT NULL,
    _meta text,
    qty numeric(10,2),
    active boolean,
    due_at timestamp,
    payload jsonb,
    tags text[],
    flags boolean[],
    matrix integer[],
    code varchar(20)
  );
  CREATE TABLE grp_alpha (id serial PRIMARY KEY);
  CREATE TABLE grp_beta (id serial PRIMARY KEY);
  CREATE VIEW v_items AS SELECT id, label FROM items;
  CREATE MATERIALIZED VIEW mv_items AS SELECT count(*) AS n FROM items;
  CREATE FUNCTION item_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM items $$;
  CREATE FUNCTION label(p integer) RETURNS integer LANGUAGE sql AS $$ SELECT p $$;
  CREATE PROCEDURE proc_noop() LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE SCHEMA app;
  CREATE TABLE app.thing (id integer PRIMARY KEY);
  CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
  CREATE FUNCTION app.thing_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM app.thing $$;
  CREATE FUNCTION app.item_count(p integer) RETURNS integer LANGUAGE sql AS $$ SELECT p $$;
  CREATE FUNCTION app.item_count(p_label text) RETURNS integer LANGUAGE sql AS $$ SELECT length(p_label) $$;
  INSERT INTO items (label, qty, active, due_at, payload, tags, flags, matrix) VALUES
    ('a', 1.50, true, '2024-01-15 10:30:00.123456', '{"b":2,"a":1}', '{red,green}', '{TRUE,FALSE}', '{{1,2},{3,4}}'),
    ('b', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
`)

const children = []
const stop = async () => {
  for (const c of children) c.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  for (const c of children) c.kill('SIGKILL')
}
process.on('uncaughtException', async (e) => {
  console.log('unexpected error:', e.message)
  await stop()
  console.log('leftover:', JSON.stringify(await teardown().catch(() => ['failed'])))
  process.exit(2)
})

console.log('\n== starting the dev stack ==')
const server = spawn('node', [join(REPO, 'server', 'dist', 'index.js')], {
  env: { ...process.env, PORT: String(API_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(server)
server.stdout.on('data', (d) => process.stdout.write(`  [api] ${d}`))
server.stderr.on('data', (d) => process.stdout.write(`  [api] ${d}`))

// Spawn vite via node directly: spawning 'npx' on Windows resolves to
// npx.cmd, which Node refuses to spawn without a shell (EINVAL since 18.20).
const vite = spawn(process.execPath, [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(REPO, 'web'),
  env: { ...process.env, PGDEV_API_PORT: String(API_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(vite)
vite.stdout.on('data', (d) => process.stdout.write(`  [web] ${d}`))
vite.stderr.on('data', (d) => process.stdout.write(`  [web] ${d}`))

const waitForHttp = async (url, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const apiUp = await (async () => {
  for (let i = 0; i < 80; i++) {
    try {
      // 403 from the origin guard still proves the server is up
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/connections/x/schema`)
      if (res.status === 403 || res.ok) return true
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})()
ok('api is listening (403 from the origin guard still proves it)', apiUp)
ok('vite is listening on IPv4', await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`))

console.log('\n== driving Chrome ==')
const chrome = await launchChrome({ port: 9377, url: `http://127.0.0.1:${WEB_PORT}/` })
const page = await openPage(9377)

try {
  try {
    await page.waitFor(`document.querySelector('.app') !== null`, { timeout: 25000 })
    ok('app shell renders', true)
  } catch (e) {
    const diag = await page.evaluate(`
      let fetched = null
      try { fetched = (await fetch(${JSON.stringify(`http://127.0.0.1:${WEB_PORT}/`)})).status } catch (err) { fetched = 'fetch failed: ' + err.message }
      return { url: location.href, readyState: document.readyState, title: document.title,
               body: document.body?.innerHTML?.slice(0, 300), fetched, html: document.documentElement.outerHTML.slice(0, 200) }
    `)
    console.log('  [diag]', JSON.stringify(diag, null, 1))
    ok('app shell renders', false, e.message)
  }

  console.log('\n== connect through the real dialog ==')
  await page.evaluate(`
    // Both the connected and the not-connected badge open the dialog.
    document.querySelector('.conn-badge')?.click()
  `)
  await page.waitFor(`document.querySelector('.modal') !== null`, { timeout: 10000 })
  ok('connect dialog opens', true)
  await page.evaluate(`
    const set = (el, v) => {
      const proto = Object.getPrototypeOf(el)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = [...document.querySelectorAll('.modal input')]
    const byLabel = (text) => inputs.find((i) => i.closest('label')?.textContent?.trim().startsWith(text))
    set(byLabel('Host'), ${JSON.stringify(base.host)})
    set(byLabel('Port'), ${JSON.stringify(String(base.port))})
    set(byLabel('Database'), ${JSON.stringify(DB)})
    set(byLabel('User'), ${JSON.stringify(base.user)})
    set(byLabel('Password'), ${JSON.stringify(base.password)})
    document.querySelector('.modal button[type=submit]')?.click()
  `)
  await page.waitFor(`document.querySelector('.modal') === null`, { timeout: 20000 })
  ok('connected and the dialog closed', true)
  // sections render collapsed, so open Tables the way a user would
  await page.evaluate(`
    const head = [...document.querySelectorAll('.group h3')].find((h) => h.textContent.trim().startsWith('Tables'))
    head?.click()
  `)
  const listed = await page.waitFor(
    `[...document.querySelectorAll('.obj-name')].some((e) => e.textContent.trim() === 'items')`,
    { timeout: 20000 },
  ).then(() => true).catch(() => false)
  ok('object browser lists the fixture tables', listed)

  console.log('\n== DDL tabs and their read-only rules ==')
  /** Expand the section holding `name`, then double-click the object. */
  const openDdl = async (name, section) => page.evaluate(`
    const want = ${JSON.stringify(name)}
    const find = () => [...document.querySelectorAll('.node')]
      .find((n) => n.querySelector('.obj-name')?.textContent?.trim() === want)
    let node = find()
    if (!node) {
      const head = [...document.querySelectorAll('.group h3')]
        .find((h) => h.textContent.trim().startsWith(${JSON.stringify(section)}))
      head?.click()
      await new Promise((r) => setTimeout(r, 300))
      node = find()
    }
    if (!node) return false
    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  `)

  ok('view found in the tree', await openDdl('v_items', 'Views'))
  await page.waitFor(`window.__pgdev && window.__pgdev.getValue().includes('v_items')`, { timeout: 15000 })
  eq('plain view tab is editable', await page.evaluate(`return window.__pgdev.getReadOnly()`), false)

  ok('materialized view found in the tree', await openDdl('mv_items', 'Views'))
  await page.waitFor(`window.__pgdev.getValue().includes('mv_items')`, { timeout: 15000 })
  eq('materialized view tab is read-only', await page.evaluate(`return window.__pgdev.getReadOnly()`), true)

  ok('table found in the tree', await openDdl('items', 'Tables'))
  await page.waitFor(`window.__pgdev.getValue().includes('CREATE TABLE')`, { timeout: 15000 })
  eq('table tab is editable', await page.evaluate(`return window.__pgdev.getReadOnly()`), false)

  ok('function found in the tree', await openDdl('item_count', 'Functions'))
  await page.waitFor(`window.__pgdev.getValue().includes('item_count')`, { timeout: 15000 })
  eq('function tab is editable', await page.evaluate(`return window.__pgdev.getReadOnly()`), false)

  console.log('\n== IntelliSense lists objects without exact duplicates ==')
  {
    await page.evaluate(`window.__pgdev.setValue('SELECT ')`)
    const result = await page.evaluate(`
      const items = window.__pgdev.suggestions()
      const keys = items.map((i) => [i.label, i.detail ?? '', i.insertText ?? ''].join('|'))
      const counts = {}
      for (const k of keys) counts[k] = (counts[k] ?? 0) + 1
      return {
        total: items.length,
        dupes: Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k),
        labels: items.map((i) => i.label),
      }
    `)
    ok('completion provider returns suggestions in the browser', result.total > 0, `${result.total} items`)
    eq('no exactly duplicated suggestions', result.dupes, [])
    ok('built-ins stay out of the unfiltered list', !result.labels.includes('json_build_object'))
    ok('user function suggested', result.labels.includes('item_count'))
    ok('view suggested', result.labels.includes('v_items'))
    ok('materialized view suggested', result.labels.includes('mv_items'))
    ok('stored procedure suggested', result.labels.includes('proc_noop'))
    ok('CALL keyword suggested', result.labels.includes('CALL'))

    // Overloads and same-named functions in other schemas are separate rows.
    const funcs = await page.evaluate(`
      return window.__pgdev.suggestions()
        .filter((i) => i.label === 'item_count')
        .map((i) => ({ insert: i.insertText, detail: i.detail }))
    `)
    eq('overloads are listed separately', funcs.length, 3)
    eq('the public function inserts unqualified',
      funcs.filter((f) => f.insert === 'item_count($0)').length, 1)
    eq('both app overloads are schema-qualified and distinct',
      funcs.filter((f) => f.insert === 'app.item_count($0)' && /· app/.test(String(f.detail))).length, 2)

    // A function named like a column must not be hidden by the column.
    const labelItems = await page.evaluate(`
      return window.__pgdev.suggestions()
        .filter((i) => i.label === 'label')
        .map((i) => i.insertText)
    `)
    ok('a function sharing a column name is still suggested',
      labelItems.includes('label($0)') && labelItems.includes('label'), JSON.stringify(labelItems))
  }

  console.log('\n== IntelliSense offers built-in functions while typing ==')
  {
    await page.evaluate(`window.__pgdev.setValue('SELECT json_')`)
    const jsonItems = await page.evaluate(`return window.__pgdev.suggestions()`)
    const build = jsonItems.find((i) => i.label === 'json_build_object')
    ok('built-in json_build_object suggested', !!build, JSON.stringify(jsonItems.slice(0, 5)))
    eq('built-in insert text is a call snippet', build?.insertText, 'json_build_object($0)')
    ok('built-in shows its signature', /→/.test(String(build?.detail)), String(build?.detail))

    await page.evaluate(`window.__pgdev.setValue('SELECT pg_')`)
    const pgLabels = await page.evaluate(`return window.__pgdev.suggestions().map((i) => i.label)`)
    ok('pg_-prefixed internals are never suggested', !pgLabels.some((l) => l.startsWith('pg_')))
  }

  console.log('\n== IntelliSense offers schema contents after a schema qualifier ==')
  {
    await page.evaluate(`window.__pgdev.setValue('SELECT * FROM app.')`)
    const fromSchema = await page.evaluate(`return window.__pgdev.suggestions().map((i) => i.label)`)
    ok('schema-qualified table suggested', fromSchema.includes('thing'), JSON.stringify(fromSchema.slice(0, 12)))
    ok('schema-qualified view suggested', fromSchema.includes('v_thing'))
    ok('schema-qualified function suggested', fromSchema.includes('thing_count'))

    await page.evaluate(`window.__pgdev.setValue('SELECT app.')`)
    const selectSchema = await page.evaluate(`return window.__pgdev.suggestions().map((i) => i.label)`)
    ok('schema contents after SELECT too', selectSchema.includes('thing_count'), JSON.stringify(selectSchema.slice(0, 12)))
    const appItems = await page.evaluate(`return window.__pgdev.suggestions()`)
    const appOverloads = appItems.filter((i) => i.label === 'item_count')
    eq('both app overloads appear after the schema qualifier', appOverloads.length, 2)
    ok('schema-qualified inserts stay unqualified after the dot',
      appOverloads.every((i) => i.insertText === 'item_count($0)'),
      JSON.stringify(appOverloads.map((i) => i.insertText)))

    // Relation qualifiers still offer columns.
    await page.evaluate(`window.__pgdev.setValue('SELECT * FROM items i WHERE i.')`)
    const cols = await page.evaluate(`return window.__pgdev.suggestions().map((i) => i.label)`)
    ok('alias qualifier still offers columns', cols.includes('id') && cols.includes('label'), JSON.stringify(cols))
  }

  console.log('\n== SQL token colors ==')
  {
    // The bundled grammar files UPDATE under its built-in functions, which
    // `vs-dark` paints magenta, and it paints strings pure red; the derived
    // pgdev-dark theme corrects both. Assert on the rendered token colors.
    await page.evaluate(`window.__pgdev.setValue("update product set x = 1;\\nselect 'p' from product")`)
    const colors = await page.waitFor(`
      (() => {
        const spans = [...document.querySelectorAll('.view-line span')]
        const pick = (text) => {
          const el = spans.find((s) => s.textContent.trim() === text)
          return el ? getComputedStyle(el).color : null
        }
        const update = pick('update')
        const select = pick('select')
        const string = pick("'p'")
        return update && select && string ? { update, select, string } : null
      })()
    `, { timeout: 15000 })
    eq('UPDATE is painted like the other keywords', colors.update, colors.select)
    eq('string literals use the muted string color', colors.string, 'rgb(206, 145, 120)')

    // Function calls stand out from column and table names.
    await page.evaluate(`window.__pgdev.setValue("select jsonb_build_object('p', _active) from product")`)
    const fnColors = await page.waitFor(`
      (() => {
        const spans = [...document.querySelectorAll('.view-line span')]
        const pick = (text) => {
          const el = spans.find((s) => s.textContent.trim() === text)
          return el ? getComputedStyle(el).color : null
        }
        const fn = pick('jsonb_build_object')
        const column = pick('_active')
        const table = pick('product')
        return fn && column && table ? { fn, column, table } : null
      })()
    `, { timeout: 15000 })
    eq('function calls get their own color', fnColors.fn, 'rgb(220, 220, 170)')
    eq('column and table names stay default', [fnColors.column, fnColors.table],
      ['rgb(212, 212, 212)', 'rgb(212, 212, 212)'])
  }

  console.log('\n== filtering makes collapse inert ==')
  {
    await page.evaluate(`
      const input = document.querySelector('.browser-search input')
      const proto = Object.getPrototypeOf(input)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, 'grp')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    `)
    await new Promise((r) => setTimeout(r, 400))
    const state = await page.evaluate(`
      const rows = () => [...document.querySelectorAll('.object-group-node')].filter((r) => r.offsetParent !== null)
      const before = rows()
      // while filtering every group is force-opened, so a click must not change
      // the row set; it must also not silently mutate the expanded set
      const openedBefore = before.map((r) => r.querySelector('.caret')?.classList.contains('open'))
      before[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      const after = rows()
      const openedAfter = after.map((r) => r.querySelector('.caret')?.classList.contains('open'))
      return {
        groupRows: before.length,
        sameRows: before.length === after.length && before.length > 0,
        sameOpened: JSON.stringify(openedBefore) === JSON.stringify(openedAfter),
        caretsHidden: [...document.querySelectorAll('.object-group-node .caret')].every((c) => !c.querySelector('svg')),
      }
    `)
    ok('a group row is present while filtering', state.groupRows > 0, `${state.groupRows} group row(s)`)
    ok('clicking it changes nothing', state.sameRows && state.sameOpened, JSON.stringify(state))
    ok('group carets are hidden while filtering', state.caretsHidden)
    await page.evaluate(`
      const input = document.querySelector('.browser-search input')
      const proto = Object.getPrototypeOf(input)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    `)
  }

  console.log('\n== opened sections survive a reload ==')
  {
    // The Tables section was opened earlier in this run; after a reload the
    // saved expansion should reopen it without any clicks.
    await page.evaluate(`location.reload()`)
    const restored = await page.waitFor(
      `[...document.querySelectorAll('.obj-name')].some((e) => e.textContent.trim() === 'items')`,
      { timeout: 25000 },
    ).then(() => true).catch(() => false)
    ok('Tables section is expanded after a reload', restored)
  }

  console.log('\n== a query error is surfaced in the UI ==')
  {
    // Run a statement the server rejects and confirm the message reaches the
    // Messages tab rather than being swallowed.
    await page.evaluate(`
      window.__pgdev.setValue('SELECT * FROM definitely_not_a_table')
    `)
    await page.evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')
      btn?.click()
    `)
    const shown = await page.waitFor(
      `document.querySelector('.results .msg.error')?.textContent?.includes('definitely_not_a_table')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('server error text appears in the results panel', shown)
  }

  console.log('\n== row editor ==')
  {
    const runQuery = async (sql) => {
      // Running is queued per tab; refuse to click while the previous run is
      // still in flight or the new click would be swallowed.
      await page.waitFor(
        `![...document.querySelectorAll('button')].some((b) => /^Cancel/.test(b.textContent.trim()))`,
        { timeout: 20000 },
      )
      await page.evaluate(`window.__pgdev.setValue(${JSON.stringify(sql)})`)
      await page.evaluate(`
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')
        btn?.click()
      `)
    }
    const setField = (name, value) => page.evaluate(`
      const field = [...document.querySelectorAll('.rowedit-field')]
        .find((f) => f.querySelector('.rowedit-name')?.textContent === ${JSON.stringify(name)})
      const el = field?.querySelector('textarea, input')
      const proto = Object.getPrototypeOf(el)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    `)
    const saveButton = `[...document.querySelectorAll('.rowedit-actions button')].find((b) => /SAVE/.test(b.textContent))`

    // A result without the primary key cannot identify rows.
    await runQuery('SELECT label FROM items ORDER BY label')
    await page.waitFor(`document.querySelectorAll('.grid-row').length > 0`, { timeout: 20000 })
    eq('a result without the primary key has no edit buttons',
      await page.evaluate(`return document.querySelectorAll('.rowedit-open').length`), 0)

    await runQuery('SELECT * FROM items ORDER BY id')
    await page.waitFor(`document.querySelectorAll('.rowedit-open').length > 0`, { timeout: 20000 })
    ok('an editable result renders row edit buttons', true)

    // Open the first row and inspect the generated controls.
    await page.evaluate(`document.querySelector('.rowedit-open')?.click()`)
    await page.waitFor(`!!document.querySelector('.rowedit-modal')`, { timeout: 10000 })
    const dialog = await page.evaluate(`
      const modal = document.querySelector('.rowedit-modal')
      const fields = [...modal.querySelectorAll('.rowedit-field')]
      const byName = (n) => fields.find((f) => f.querySelector('.rowedit-name')?.textContent === n)
      return {
        title: modal.querySelector('.rowedit-title')?.textContent,
        table: modal.querySelector('.rowedit-table')?.textContent,
        names: fields.map((f) => f.querySelector('.rowedit-name')?.textContent),
        idLocked: !!byName('id')?.querySelector('.rowedit-locked'),
        idTag: byName('id')?.querySelector('.rowedit-tag')?.textContent,
        qtyType: byName('qty')?.querySelector('input')?.type,
        activeCheckboxes: byName('active')?.querySelectorAll('input[type=checkbox]').length,
        dueType: byName('due_at')?.querySelector('input')?.type,
        dueValue: byName('due_at')?.querySelector('input')?.value,
        payloadJson: /json/.test(byName('payload')?.querySelector('textarea')?.className ?? ''),
        payloadText: byName('payload')?.querySelector('textarea')?.value,
        codeType: byName('code')?.querySelector('input')?.type,
        codeMax: byName('code')?.querySelector('input')?.maxLength,
        labelMax: byName('label')?.querySelector('textarea')?.maxLength,
        tagType: byName('tags')?.querySelector('input')?.type,
        tagValue: byName('tags')?.querySelector('input')?.value,
        flagType: byName('flags')?.querySelector('input')?.type,
        flagValue: byName('flags')?.querySelector('input')?.value,
        matrixTag: byName('matrix')?.querySelector('.rowedit-tag')?.textContent,
        matrixLocked: !!byName('matrix')?.querySelector('.rowedit-locked'),
        matrixInput: !!byName('matrix')?.querySelector('input'),
        labelTag: byName('label')?.querySelector('textarea') ? 'textarea' : (byName('label')?.querySelector('input')?.tagName ?? null),
        labelNull: !!byName('label')?.querySelector('.rowedit-null'),
        qtyNull: !!byName('qty')?.querySelector('.rowedit-null'),
        nullChecks: modal.querySelectorAll('.rowedit-null').length,
        saveDisabled: ${saveButton}?.disabled,
      }
    `)
    eq('dialog title and table', [dialog.title, dialog.table], ['Edit row', 'public.items'])
    eq('dialog lists every result column, underscore columns last',
      dialog.names, ['id', 'label', 'qty', 'active', 'due_at', 'payload', 'tags', 'flags', 'matrix', 'code', '_meta'])
    eq('the primary key is locked and tagged', [dialog.idLocked, dialog.idTag], [true, 'primary key'])
    eq('numeric columns get a number input', dialog.qtyType, 'number')
    eq('booleans get a value checkbox and a NULL checkbox', dialog.activeCheckboxes, 2)
    eq('timestamps get a datetime-local input', dialog.dueType, 'datetime-local')
    // PostgreSQL microseconds are truncated to milliseconds: more digits are
    // an invalid value for a native datetime-local control (it renders empty).
    eq('the timestamp control holds the wall time', dialog.dueValue, '2024-01-15T10:30:00.123')
    ok('json gets a pretty-printed textarea', dialog.payloadJson && dialog.payloadText.includes('\n  "a": 1'), dialog.payloadText)
    eq('text columns keep the textarea', dialog.labelTag, 'textarea')
    eq('varchar columns get a single-line text input', dialog.codeType, 'text')
    eq('varchar(n) input carries the declared maxlength', dialog.codeMax, 20)
    eq('text columns have no maxlength', dialog.labelMax, -1)
    eq('array columns get a single-line literal input', [dialog.tagType, dialog.tagValue], ['text', '{red,green}'])
    eq('boolean arrays get a single-line literal input', [dialog.flagType, dialog.flagValue], ['text', '{t,f}'])
    eq('multi-dimensional arrays are locked',
      [dialog.matrixTag, dialog.matrixLocked, dialog.matrixInput], ['multi-dimensional', true, false])
    eq('NOT NULL columns offer no NULL checkbox', dialog.labelNull, false)
    eq('nullable columns offer a NULL checkbox', dialog.qtyNull, true)
    eq('one NULL checkbox per nullable field', dialog.nullChecks, 8)
    eq('SAVE starts disabled', dialog.saveDisabled, true)

    // Native date/time controls otherwise render with the browser's default
    // font and chrome; they must match the plain text inputs.
    const unified = await page.evaluate(`
      const modal = document.querySelector('.rowedit-modal')
      const byName = (n) => [...modal.querySelectorAll('.rowedit-field')]
        .find((f) => f.querySelector('.rowedit-name')?.textContent === n)
      const pick = (n) => {
        const s = getComputedStyle(byName(n)?.querySelector('input'))
        return { size: s.fontSize, family: s.fontFamily, padding: s.padding, bg: s.backgroundColor, radius: s.borderRadius }
      }
      return { date: pick('due_at'), text: pick('code') }
    `)
    eq('date/time inputs share the text input styling', unified.date, unified.text)

    // Invalid JSON never leaves the browser: the dialog validates the text
    // before building the UPDATE, so the field error appears without a round
    // trip. Restore the field afterwards so CANCEL needs no confirm.
    await setField('payload', '{oops')
    eq('SAVE is enabled after an edit',
      await page.evaluate(`return ${saveButton}?.disabled`), false)
    await page.evaluate(`${saveButton}?.click()`)
    const jsonCaught = await page.waitFor(
      `document.querySelector('.rowedit-error')?.textContent?.includes('JSON')`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('invalid JSON is rejected before saving', jsonCaught)
    ok('the dialog stays open after invalid JSON',
      await page.evaluate(`return !!document.querySelector('.rowedit-modal')`))
    await setField('payload', dialog.payloadText)

    // A real server rejection (numeric overflow) keeps the dialog open with
    // the PostgreSQL message.
    await setField('qty', '99999999999')
    await page.evaluate(`${saveButton}?.click()`)
    const failed = await page.waitFor(
      `!!document.querySelector('.rowedit-error') && !document.querySelector('.rowedit-error')?.textContent?.includes('JSON')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('a server rejection is shown in the dialog', failed)
    ok('the dialog stays open after a rejection',
      await page.evaluate(`return !!document.querySelector('.rowedit-modal')`))
    await setField('qty', '1.50')
    await page.evaluate(`[...document.querySelectorAll('.rowedit-actions button')].find((b) => b.textContent.trim() === 'CANCEL')?.click()`)
    await page.waitFor(`!document.querySelector('.rowedit-modal')`, { timeout: 10000 })
    ok('CANCEL closes the dialog', true)

    // A successful save patches the grid from the RETURNING row.
    await page.evaluate(`document.querySelector('.rowedit-open')?.click()`)
    await page.waitFor(`!!document.querySelector('.rowedit-modal')`, { timeout: 10000 })
    await setField('label', 'edited-in-browser')
    await setField('tags', '{blue, green}')
    await page.evaluate(`${saveButton}?.click()`)
    await page.waitFor(`!document.querySelector('.rowedit-modal')`, { timeout: 20000 })
    ok('the dialog closes after a successful save', true)
    const patched = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === 'edited-in-browser')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('the grid cell shows the saved value', patched)
    const arrayPatched = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === '{blue,green}')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('the grid shows the saved array literal', arrayPatched)

    // And both values are really in the database.
    await runQuery('SELECT label, tags FROM items WHERE id = 1')
    const stored = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === 'edited-in-browser')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('the saved value is stored in the database', stored)
    const arrayStored = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === '{blue,green}')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('the array change is stored in the database', arrayStored)
  }

  console.log('\n== disconnecting disables running ==')
  {
    // Disconnect lives in the connection dialog since the top-bar button moved.
    await page.evaluate(`
      document.querySelector('.conn-badge')?.click()
    `)
    await page.waitFor(`!!document.querySelector('.saved-item.current')`, { timeout: 10000 }).catch(() => {})
    await page.evaluate(`
      document.querySelector('.connect-modal button[title="Disconnect"]')?.click()
    `)
    const off = await page.waitFor(
      `document.querySelector('.conn-badge')?.classList.contains('off')`,
      { timeout: 15000 },
    ).then(() => true).catch(() => false)
    ok('badge returns to not-connected', off)
    const runDisabled = await page.evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')
      return btn ? btn.disabled : true
    `)
    ok('Run is disabled once disconnected', runDisabled)
  }

  console.log('\n== console cleanliness ==')
  const noisy = page.consoleErrors.filter((e) => !/favicon|Download the Vue Devtools/i.test(e))
  ok('no console errors during the run', noisy.length === 0, noisy.slice(0, 3).join(' | '))
} finally {
  await page.close().catch(() => {})
  await chrome.close().catch(() => {})
  await stop()
}

const left = await teardown()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
