// Browser end-to-end checks over the DevTools Protocol — no dependencies.
//
// Starts the real server and the Vite dev server against a scratch database,
// then drives Chrome. Opt-in: set PGDEV_TEST_URL and PGDEV_BROWSER=1, because
// it needs the dev stack and a Chrome binary.
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  -- Two parents whose names sanitize alike ("a.b" and a_b both fold to
  -- a_b), each holding a constraint named c (legal: constraint names are
  -- table-scoped): their DDL tab keys collided before the model URIs
  -- became lossless.
  CREATE TABLE "a.b" (a integer NOT NULL, CONSTRAINT c CHECK (a > 0));
  CREATE TABLE a_b (a integer NOT NULL, CONSTRAINT c CHECK (a > 0));
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
  COMMENT ON FUNCTION item_count() IS 'Counts all items.';
  COMMENT ON FUNCTION label(integer) IS 'Echoes the given id.';
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
// Scratch agent token: the suite must never read or write the user's real one.
const aiTokenFile = join(tmpdir(), `pgdev_aitoken_${process.pid}`)
const server = spawn('node', [join(REPO, 'server', 'dist', 'index.js')], {
  env: { ...process.env, PORT: String(API_PORT), PGDEV_TOKEN_FILE: aiTokenFile },
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

  console.log('\n== the topbar toggle hides and restores the navigation panel ==')
  {
    const toggleTitle = async () => page.evaluate(`
      return [...document.querySelectorAll('.topbar button.icon')]
        .find((b) => /navigation panel/.test(b.title))?.title ?? null
    `)
    const layout = async () => page.evaluate(`
      const sidebar = document.querySelector('.sidebar')
      return {
        present: sidebar !== null,
        shown: !!sidebar && getComputedStyle(sidebar).display !== 'none',
        width: sidebar?.style.width ?? '',
        mainLeft: document.querySelector('.pgdev-main')?.getBoundingClientRect().left ?? -1,
        iconPanels: document.querySelectorAll('.icon-panel').length,
      }
    `)
    eq('the topbar offers collapsing', await toggleTitle(), 'Collapse navigation panel')
    const order = await page.evaluate(`
      return {
        logo: document.querySelector('.topbar .logo')?.getBoundingClientRect().right ?? -1,
        toggle: [...document.querySelectorAll('.topbar button.icon')]
          .find((b) => /navigation panel/.test(b.title))?.getBoundingClientRect().left ?? -1,
      }
    `)
    ok('the toggle sits just after the logo', order.toggle > order.logo, JSON.stringify(order))
    // The two splitters must meet exactly: the results handle starts where the
    // panel handle starts, never a pixel into the panel — and ends where the
    // editor column ends.
    const junction = await page.evaluate(`
      const v = document.querySelector('.drag-v')?.getBoundingClientRect()
      const h = document.querySelector('.drag-h')?.getBoundingClientRect()
      const panel = document.querySelector('.sidebar')?.getBoundingClientRect()
      const main = document.querySelector('.pgdev-main')?.getBoundingClientRect()
      return {
        vLeft: v?.left ?? -1,
        hLeft: h?.left ?? -1,
        panelRight: panel?.right ?? -1,
        hRight: h?.right ?? -1,
        mainRight: main?.right ?? -1,
      }
    `)
    ok('the results splitter starts at the panel handle',
      Math.abs(junction.hLeft - junction.vLeft) < 0.5 && junction.hLeft >= junction.panelRight,
      JSON.stringify(junction))
    ok('and spans the editor column', Math.abs(junction.hRight - junction.mainRight) < 0.5, JSON.stringify(junction))
    const before = await layout()
    ok('the panel starts out shown', before.present && before.shown && before.mainLeft > 0, JSON.stringify(before))
    ok('with no leftover icon strip', before.iconPanels === 0)

    await page.evaluate(`
      [...document.querySelectorAll('.topbar button.icon')]
        .find((b) => b.title === 'Collapse navigation panel')?.click()
    `)
    const gone = await page.waitFor(
      `getComputedStyle(document.querySelector('.sidebar')).display === 'none'`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('the panel disappears completely', gone)
    const collapsed = await layout()
    ok('leaving no strip behind the editor', collapsed.mainLeft === 0 && collapsed.iconPanels === 0, JSON.stringify(collapsed))
    eq('and the topbar icon flips to expanding', await toggleTitle(), 'Expand navigation panel')

    await page.evaluate(`
      [...document.querySelectorAll('.topbar button.icon')]
        .find((b) => b.title === 'Expand navigation panel')?.click()
    `)
    const back = await page.waitFor(
      `getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('the panel comes back', back)
    eq('at its width', (await layout()).width, before.width)
    const stillThere = await page.waitFor(
      `[...document.querySelectorAll('.obj-name')].some((e) => e.textContent.trim() === 'items')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('and the object browser keeps its state', stillThere)
  }

  // Acts as the MCP client for the AI bridge checks: the browser suite is the
  // window the agent talks to, so it calls the token-guarded tool endpoints.
  let aiToken = ''
  const aiTool = async (name, args = {}) => {
    if (!aiToken) {
      const cfg = await page.evaluate(`return (await fetch('/api/ai/config')).json()`)
      aiToken = cfg?.token ?? ''
      ok('the AI config carries the token', Boolean(aiToken))
    }
    return page.evaluate(`
      const res = await fetch(${JSON.stringify(`/api/ai/tool/${name}`)}, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + ${JSON.stringify(aiToken)},
        },
        body: ${JSON.stringify(JSON.stringify(args))},
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    `)
  }

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
  await page.waitFor(`window.__pgdev && window.__pgdev.getValue().includes('item_count')`, { timeout: 15000 })
  eq('function tab is editable', await page.evaluate(`return window.__pgdev.getReadOnly()`), false)

  // Two same-named constraints under parents whose keys sanitize alike
  // ("a.b" and a_b both folded to a_b): both tabs must open, each with its
  // own model — the second createModel used to throw on a shared URI.
  /** Expand a table's caret, its Constraints category, then dblclick `c`. */
  const openConstraintDdl = async (table) => page.evaluate(`
    const wantTable = ${JSON.stringify(table)}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = (name) => [...document.querySelectorAll('.node')]
      .find((n) => n.querySelector('.obj-name')?.textContent?.trim() === name)
    const tableRow = row(wantTable)
    if (!tableRow) return 'no table row'
    tableRow.querySelector('.caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const wrapper = tableRow.closest('.tree')
    for (let i = 0; i < 20 && ![...wrapper.querySelectorAll('.node')]
      .some((n) => n.querySelector('.obj-name')?.textContent?.trim() === 'Constraints'); i++) await sleep(50)
    const category = [...wrapper.querySelectorAll('.node')]
      .find((n) => n.querySelector('.obj-name')?.textContent?.trim() === 'Constraints')
    category?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let i = 0; i < 20 && ![...wrapper.querySelectorAll('.cat-child')]
      .some((n) => n.querySelector('.obj-name')?.textContent?.trim() === 'c'); i++) await sleep(50)
    const constraintRow = [...wrapper.querySelectorAll('.cat-child')]
      .find((n) => n.querySelector('.obj-name')?.textContent?.trim() === 'c')
    if (!constraintRow) return 'no constraint row'
    constraintRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  `)
  const tabCount = () => page.evaluate(`return document.querySelectorAll('.tabstrip .tab').length`)
  const modelCount = () => page.evaluate(`return window.__pgdev.monaco.editor.getModels().length`)
  const tabsBefore = await tabCount()
  const modelsBefore = await modelCount()
  ok('a.b constraint found in the tree', await openConstraintDdl('a.b'))
  await page.waitFor(`document.querySelectorAll('.tabstrip .tab').length > ${tabsBefore}`, { timeout: 15000 })
  eq('a_b constraint found in the tree', await openConstraintDdl('a_b'), true)
  await page.waitFor(`document.querySelectorAll('.tabstrip .tab').length > ${tabsBefore + 1}`, { timeout: 15000 })
  eq('each same-named constraint got its own model', (await modelCount()) - modelsBefore, 2)
  const constraintTabs = await page.evaluate(
    `return [...document.querySelectorAll('.tabstrip .tab-title')].map((e) => e.textContent.trim())`,
  )
  eq('both colliding constraint tabs exist', constraintTabs.filter((t) => t === 'c').length, 2,
    JSON.stringify(constraintTabs))

  console.log('\n== double-clicking the tab strip opens a query tab ==')
  {
    const before = await page.evaluate(`return document.querySelectorAll('.tabstrip .tab').length`)
    await page.evaluate(`
      const strip = document.querySelector('.tabstrip')
      strip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    `)
    await new Promise((r) => setTimeout(r, 250))
    const after = await page.evaluate(`return document.querySelectorAll('.tabstrip .tab').length`)
    eq('double-clicking the empty strip adds a query tab', after, before + 1)
  }

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

    // At a call site the function ranks above the column and both rows are
    // described inline.
    await page.evaluate(`window.__pgdev.setValue('select label(')`)
    const atCall = await page.evaluate(`return window.__pgdev.suggestions('label')`)
    const callFn = atCall.find((i) => i.insertText === 'label($0)')
    const callCol = atCall.find((i) => i.insertText === 'label')
    ok('functions rank above columns at a call site',
      String(callFn?.sortText ?? '').startsWith('0') && !callCol?.sortText,
      JSON.stringify([callFn, callCol]))
    ok('function description carries the parameter list', /\(p integer\)/.test(String(callFn?.description)))
    ok('column description carries type and relation', /text · /.test(String(callCol?.description)))
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

  console.log('\n== IntelliSense hover ==')
  {
    const hover = async (sql, needle) => {
      await page.evaluate(`window.__pgdev.setValue(${JSON.stringify(sql)})`)
      return page.evaluate(`return window.__pgdev.hover(${JSON.stringify(needle)})`)
    }

    const func = await hover('select item_count() from items', 'item_count')
    ok('user function hover shows signature, kind and comment',
      /\*\*item_count\*\*\(\) → integer/.test(func?.markdown ?? '') &&
      func.markdown.includes('_function · public_') &&
      func.markdown.includes('Counts all items.'),
      JSON.stringify(func))

    const builtin = await hover('select jsonb_build_object(1, 2)', 'jsonb_build_object')
    ok('built-in hover shows the signature and pg_catalog',
      /\(VARIADIC "any"\)/.test(builtin?.markdown ?? '') &&
      builtin.markdown.includes('_function · pg_catalog_'),
      JSON.stringify(builtin))

    const collision = await hover('select label(1) from items', 'label')
    ok('at a call site the function wins over a same-named column',
      /\(p integer\)/.test(collision?.markdown ?? '') &&
      collision.markdown.includes('Echoes the given id.') &&
      !collision.markdown.includes('text · items'),
      JSON.stringify(collision))

    const column = await hover('select i.label from items i', 'label')
    ok('a plain column hover shows type, relation and nullability',
      /^\*\*label\*\*/.test(column?.markdown ?? '') &&
      column.markdown.includes('_text · items · not null_') &&
      !column.markdown.includes('Echoes'),
      JSON.stringify(column))

    const qualified = await hover('select app.item_count(1)', 'item_count')
    ok('schema-qualified hover names the schema',
      /\(p integer\)/.test(qualified?.markdown ?? '') &&
      qualified.markdown.includes('_function · app_'),
      JSON.stringify(qualified))
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
    eq('function calls get their own color', fnColors.fn, 'rgb(255, 198, 109)')
    eq('column and table names stay default', [fnColors.column, fnColors.table],
      ['rgb(212, 212, 212)', 'rgb(212, 212, 212)'])

    // A function whose name the grammar lists as a keyword (TRANSLATION is a
    // SQL Server spelling) must still read as a call, while clause keywords
    // that precede a parenthesis keep the keyword color.
    await page.evaluate(`window.__pgdev.setValue("ORDER BY\\n\\ttemp.event_type,\\n\\ttranslation(d.translation, $4, d.code)")`)
    const keywordCall = await page.waitFor(`
      (() => {
        const spans = [...document.querySelectorAll('.view-line span')]
        const colors = spans.filter((s) => s.textContent.trim() === 'translation')
          .map((s) => getComputedStyle(s).color)
        return colors.length === 2 ? colors : null
      })()
    `, { timeout: 15000 })
    eq('a keyword-named function call gets the function color', keywordCall[0], 'rgb(255, 198, 109)')
    eq('the plain mention keeps its keyword color', keywordCall[1], 'rgb(86, 156, 214)')

    await page.evaluate(`window.__pgdev.setValue('select * from t where id in (1);\\ninsert into t values (2)')`)
    const clauseColors = await page.waitFor(`
      (() => {
        const spans = [...document.querySelectorAll('.view-line span')]
        const pick = (text) => {
          const el = spans.find((s) => s.textContent.trim() === text)
          return el ? getComputedStyle(el).color : null
        }
        const inColor = pick('in')
        const valuesColor = pick('values')
        return inColor && valuesColor ? { inColor, valuesColor } : null
      })()
    `, { timeout: 15000 })
    eq('clause keywords keep their color before a parenthesis',
      [clauseColors.inColor, clauseColors.valuesColor], ['rgb(86, 156, 214)', 'rgb(86, 156, 214)'])
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

  console.log('\n== browser search ignores argument types ==')
  {
    const search = async (text) => {
      await page.evaluate(`
        const input = document.querySelector('.browser-search input')
        const proto = Object.getPrototypeOf(input)
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(text)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      `)
      await new Promise((r) => setTimeout(r, 350))
      return page.evaluate(`
        return {
          names: [...document.querySelectorAll('.obj-name')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()),
          noMatch: !!document.querySelector('.no-match'),
        }
      `)
    }

    // `integer` appears only in argument types in the fixture, so nothing matches.
    const byType = await search('integer')
    ok('a type-only search matches nothing', byType.noMatch, JSON.stringify(byType.names.slice(0, 10)))

    // The parameter's own name is still searched and opens the function.
    const byParam = await search('p_label')
    ok('a parameter name still matches its function',
      byParam.names.some((n) => n.endsWith('item_count')), JSON.stringify(byParam.names.slice(0, 10)))
    ok('the matching parameter is listed',
      byParam.names.includes('p_label'), JSON.stringify(byParam.names.slice(0, 10)))

    await search('')
  }

  console.log('\n== PREPARE template from $N parameters ==')
  {
    await page.evaluate(`window.__pgdev.setValue("SELECT * FROM items WHERE id = $1 AND label = $2")`)
    // The toolbar button opens the values bar; Enter applies it.
    await page.evaluate(`
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /PREPARE \\/ EXECUTE/.test(b.title))
      btn?.click()
    `)
    await page.waitFor(`!!document.querySelector('.param-bar input')`, { timeout: 10000 })
    await page.evaluate(`
      const input = document.querySelector('.param-bar input')
      const proto = Object.getPrototypeOf(input)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '-- [7, "a"]')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    `)
    await page.waitFor(`window.__pgdev.getValue().startsWith('PREPARE temp AS')`, { timeout: 15000 })
    const script = await page.evaluate(`return window.__pgdev.getValue()`)
    ok('the template declares no parameter type list', /^PREPARE temp AS\r?\n/.test(script), JSON.stringify(script.slice(0, 60)))
    ok('pasted values become literals with parameter comments',
      /EXECUTE temp\(\r?\n\t7, -- \$1\r?\n\t'a' -- \$2\r?\n\);/.test(script), JSON.stringify(script))
  }

  console.log('\n== AI bridge ==')
  {
    /** Poll the tool until the active result holds `want` rows (settings pushes
     * and the run itself are asynchronous). */
    const readActiveResult = async (want) => {
      let out = null
      for (let i = 0; i < 30; i++) {
        out = await aiTool('get_active_result')
        if (out.body.result?.results?.[0]?.rows?.length === want) return out
        await new Promise((r) => setTimeout(r, 150))
      }
      return out
    }

    /** Drive Settings → AI agent → Row limit, exactly as a user would. */
    const setAiRowLimit = async (value) => {
      await page.evaluate(`
        const open = [...document.querySelectorAll('button')].find((b) => b.title === 'Settings')
        if (open && !document.querySelector('.settings-modal')) open.click()
      `)
      await page.waitFor(`!!document.querySelector('.settings-modal')`, { timeout: 10000 })
      await page.evaluate(`
        const section = [...document.querySelectorAll('.settings-section')]
          .find((s) => s.querySelector('h3')?.textContent.trim() === 'AI agent')
        const input = section.querySelector('.stepper-input')
        const proto = Object.getPrototypeOf(input)
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(String(value))})
        input.dispatchEvent(new Event('change', { bubbles: true }))
      `)
      await page.evaluate(`document.querySelector('.settings-modal button.icon')?.click()`)
      await page.waitFor(`!document.querySelector('.settings-modal')`, { timeout: 10000 }).catch(() => {})
    }

    // The window is the page under test: the tools above reached it over the
    // SSE bridge, which is only up when the page subscribed on load.
    await page.evaluate(`window.__pgdev.setValue('SELECT 1 AS ai_probe')`)
    const active = await aiTool('get_active_query')
    // Report the real cause when another pgDEV window grabbed the bridge: the
    // server refuses rather than broadcasting to every subscribed window.
    ok(
      'no other pgDEV window is subscribed to the bridge',
      active.body.ok !== false || !/windows are listening/.test(active.body.error),
      active.body.error,
    )
    eq('get_active_query reads the editor', active.body.result?.sql, 'SELECT 1 AS ai_probe')

    const replaced = await aiTool('set_active_query', { sql: 'SELECT 2 AS ai_replaced' })
    eq('set_active_query succeeds', replaced.body.ok, true)
    const shownInEditor = await page.waitFor(
      `window.__pgdev.getValue() === 'SELECT 2 AS ai_replaced'`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('the editor shows the agent SQL', shownInEditor)

    const tabsBefore = await page.evaluate(`return document.querySelectorAll('.tabstrip .tab').length`)
    const opened = await aiTool('open_query_tab', { sql: 'CREATE VIEW ai_view AS SELECT 1', title: 'ai_view' })
    eq('open_query_tab returns a tab key', typeof opened.body.result?.key, 'string')
    const tabsAfter = await page.evaluate(`return document.querySelectorAll('.tabstrip .tab').length`)
    eq('a tab was opened', tabsAfter, tabsBefore + 1)
    const openedShown = await page.waitFor(
      `window.__pgdev.getValue() === 'CREATE VIEW ai_view AS SELECT 1'`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('the new tab holds the agent SQL', openedShown)

    const read = await aiTool('query', { sql: 'SELECT 42 AS answer' })
    eq('the agent query returns rows', read.body.result?.results?.[0]?.rows, [[42]])
    eq('the running window was told to mirror the rows', read.body.result?.shown, true)
    const gridShown = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === '42')`,
      { timeout: 15000 },
    ).then(() => true).catch(() => false)
    ok('the agent rows are visible in a grid', gridShown)
    const titles = await page.evaluate(
      `return [...document.querySelectorAll('.tabstrip .tab-title')].map((t) => t.textContent.trim())`,
    )
    ok('the mirrored result lives in the AI tab', titles.includes('AI'), JSON.stringify(titles))

    // The agent can stage SQL but never run the editor: the tool is gone.
    await aiTool('set_active_query', { sql: "UPDATE items SET label = 'ai'" })
    const removed = await aiTool('run_active_query')
    eq('the agent cannot run the editor', removed.status, 404)
    const noList = await aiTool('list_connections')
    eq('the agent cannot list connections', noList.status, 404)

    // Database tools use the connection the window has open, with no argument.
    const schema = await aiTool('get_schema', { table: 'items' })
    eq('get_schema reads the connection open in the window',
      schema.body.result?.tables?.map((t) => t.name), ['items'])

    // The agent can read what the active tab produced: the mirrored rows and
    // the Messages text.
    const mirrored = await aiTool('get_active_result')
    eq('the agent reads the mirrored rows', mirrored.body.result?.results?.[0]?.rows, [[42]])
    eq('and knows the tab it came from', mirrored.body.result?.tab?.title, 'AI')
    eq('and that the tab has run', mirrored.body.result?.ran, true)
    ok('with the tab message',
      /Agent query: 1 row\(s\)/.test(mirrored.body.result?.messages?.[0]?.text ?? ''),
      JSON.stringify(mirrored.body.result?.messages))

    // Run a real query in the tab and watch the agent's row limit apply.
    await page.evaluate(`window.__pgdev.setValue('SELECT g AS n FROM generate_series(1, 5) g ORDER BY g')`)
    await page.evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')
      btn?.click()
    `)
    const fiveRows = await page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === '5')`,
      { timeout: 15000 },
    ).then(() => true).catch(() => false)
    ok('the user query produced five rows', fiveRows)
    const fullResult = await readActiveResult(5)
    eq('the agent reads the rows the user sees', fullResult.body.result?.results?.[0]?.rows?.length, 5)
    ok('and the statement message',
      /\d+ row\(s\)/.test(fullResult.body.result?.messages?.find((m) => /row\(s\)/.test(m.text))?.text ?? ''),
      JSON.stringify(fullResult.body.result?.messages))

    await setAiRowLimit(2)
    const limited = await readActiveResult(2)
    eq('the row limit from Settings applies to the agent', limited.body.result?.results?.[0]?.rows?.length, 2)
    eq('and the cut is reported', limited.body.result?.results?.[0]?.truncated, true)
    await setAiRowLimit(100)

    // The agent manages the tabs it opened: list, activate, close.
    const one = await aiTool('open_query_tab', { sql: '-- tab one', title: 'tab_one' })
    const two = await aiTool('open_query_tab', { sql: '-- tab two', title: 'tab_two' })
    const listed = await aiTool('list_tabs')
    const names = (listed.body.result?.tabs ?? []).map((t) => t.title)
    ok('list_tabs shows the tabs the agent opened',
      names.includes('tab_one') && names.includes('tab_two'), JSON.stringify(names))
    const domTitles = await page.evaluate(
      `return [...document.querySelectorAll('.tabstrip .tab-title')].map((t) => t.textContent.trim().replace(/ \\*$/, ''))`,
    )
    ok('and none of the user tabs', domTitles.includes('Query 1') && !names.includes('Query 1'))
    ok('freshly staged tabs are clean',
      (listed.body.result?.tabs ?? [])
        .filter((t) => t.title === 'tab_one' || t.title === 'tab_two')
        .every((t) => t.dirty === false))

    const stripState = await page.evaluate(`
      return [...document.querySelectorAll('.tabstrip .tab')].map((t) => ({
        title: (t.querySelector('.tab-title')?.textContent ?? '').trim().replace(/ \\*$/, ''),
        agent: t.classList.contains('agent-tab'),
      }))
    `)
    const agentTitles = stripState.filter((t) => t.agent).map((t) => t.title)
    ok('agent-opened tabs are tinted in the strip',
      ['tab_one', 'tab_two', 'AI', 'ai_view'].every((want) => agentTitles.includes(want)),
      JSON.stringify(stripState))
    ok('user tabs are not tinted',
      ['Query 1', 'Query 2', 'v_items', 'mv_items', 'items', 'item_count'].every((want) => !agentTitles.includes(want)),
      JSON.stringify(stripState))

    await aiTool('activate_tab', { tab: 'tab_one' })
    await aiTool('set_active_query', { sql: '-- appended', mode: 'append' })
    const dirtied = await aiTool('list_tabs')
    eq('a modified tab is flagged dirty',
      dirtied.body.result?.tabs?.find((t) => t.key === one.body.result?.key)?.dirty, true)

    const dirtyClose = await aiTool('close_tab', { tab: 'tab_one' })
    ok('a dirty tab is refused by name',
      dirtyClose.body.ok === false && /unsaved changes/.test(dirtyClose.body.error),
      JSON.stringify(dirtyClose.body))

    const closed = await aiTool('close_tab', { tab: 'tab_two' })
    eq('a clean agent tab closes', closed.body.ok, true)
    const after = await aiTool('list_tabs')
    ok('it is gone afterwards',
      !(after.body.result?.tabs ?? []).some((t) => t.key === two.body.result?.key))

    const back = await aiTool('activate_tab', { tab: 'tab_one' })
    eq('activate_tab returns the tab', back.body.result?.key, one.body.result?.key)
    const tabShown = await page.waitFor(
      `window.__pgdev.getValue().includes('-- appended')`,
      { timeout: 10000 },
    ).then(() => true).catch(() => false)
    ok('the editor shows the activated tab', tabShown)

    const agentTitleSet = new Set((after.body.result?.tabs ?? []).map((t) => t.title))
    const foreign = domTitles.find((t) => !agentTitleSet.has(t))
    const foreignClose = await aiTool('close_tab', { tab: foreign })
    ok('a user tab is refused as foreign',
      foreignClose.body.ok === false && /was not opened by the agent/.test(foreignClose.body.error),
      JSON.stringify(foreignClose.body))
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

    // The bridge must come back up with the restored page.
    let bridgeBack = false
    for (let i = 0; i < 40 && !bridgeBack; i++) {
      const probe = await aiTool('get_active_query')
      bridgeBack = probe.body?.ok === true
      if (!bridgeBack) await new Promise((r) => setTimeout(r, 250))
    }
    ok('the AI bridge reconnects after a reload', bridgeBack)
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

    // The agent gets the same failure, as a message, from the tool.
    const failed = await aiTool('get_active_result')
    ok('the agent sees the failed statement',
      failed.body.result?.messages?.some((m) => m.level === 'error' && /definitely_not_a_table/.test(m.text)),
      JSON.stringify(failed.body.result?.messages))
    eq('and no rows for it', failed.body.result?.results, [])
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
  const noisy = page.consoleErrors.filter((e) => {
    if (/favicon|Download the Vue Devtools/i.test(e)) return false
    // Upstream Monaco noise: the built-in word highlighter keeps a delayed
    // document-highlight promise, and disposing it on a model switch rejects
    // that promise with a CancellationError nobody handles, so a tab switch
    // while a highlight is in flight logs "Canceled: Canceled" from Delayer.
    return !/Canceled: Canceled[\s\S]*Delayer\.cancel/.test(e)
  })
  ok('no console errors during the run', noisy.length === 0, noisy.slice(0, 3).join(' | '))
} finally {
  await page.close().catch(() => {})
  await chrome.close().catch(() => {})
  await stop()
  rmSync(aiTokenFile, { force: true })
}

const left = await teardown()
console.log(`\nleftover pgdev_% databases: ${JSON.stringify(left)}`)
process.exit(report() ? 0 : 1)
