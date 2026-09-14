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
  CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL);
  CREATE TABLE grp_alpha (id serial PRIMARY KEY);
  CREATE TABLE grp_beta (id serial PRIMARY KEY);
  CREATE VIEW v_items AS SELECT id, label FROM items;
  CREATE MATERIALIZED VIEW mv_items AS SELECT count(*) AS n FROM items;
  CREATE FUNCTION item_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM items $$;
  CREATE PROCEDURE proc_noop() LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE SCHEMA app;
  CREATE TABLE app.thing (id integer PRIMARY KEY);
  CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
  CREATE FUNCTION app.thing_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM app.thing $$;
  INSERT INTO items (label) VALUES ('a'), ('b');
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

  console.log('\n== IntelliSense has no duplicate labels ==')
  {
    await page.evaluate(`window.__pgdev.setValue('SELECT ')`)
    const result = await page.evaluate(`
      const items = window.__pgdev.suggestions()
      const counts = {}
      for (const i of items) counts[i.label] = (counts[i.label] ?? 0) + 1
      const dupes = Object.entries(counts).filter(([, n]) => n > 1)
      return { total: items.length, unique: Object.keys(counts).length, labels: items.map((i) => i.label), dupes: dupes.map(([l, n]) => l + ' x' + n) }
    `)
    ok('completion provider returns suggestions in the browser', result.total > 0, `${result.total} items`)
    eq('no duplicated labels', result.dupes, [])
    ok('column names appear once each', result.total === result.unique, `${result.unique}/${result.total} unique`)
    ok('user function suggested', result.labels.includes('item_count'))
    ok('view suggested', result.labels.includes('v_items'))
    ok('materialized view suggested', result.labels.includes('mv_items'))
    ok('stored procedure suggested', result.labels.includes('proc_noop'))
    ok('CALL keyword suggested', result.labels.includes('CALL'))
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

    // Relation qualifiers still offer columns.
    await page.evaluate(`window.__pgdev.setValue('SELECT * FROM items i WHERE i.')`)
    const cols = await page.evaluate(`return window.__pgdev.suggestions().map((i) => i.label)`)
    ok('alias qualifier still offers columns', cols.includes('id') && cols.includes('label'), JSON.stringify(cols))
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
      `document.body.textContent.includes('definitely_not_a_table')`,
      { timeout: 20000 },
    ).then(() => true).catch(() => false)
    ok('server error text appears in the results panel', shown)
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
