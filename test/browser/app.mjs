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
  -- A single sequence: the collapse-inert group checks count group rows, and
  -- one sequence cannot form a second group.
  CREATE SEQUENCE item_counter AS integer INCREMENT 10 MINVALUE 5 START 100;
  CREATE FUNCTION item_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM items $$;
  CREATE FUNCTION label(p integer) RETURNS integer LANGUAGE sql AS $$ SELECT p $$;
  CREATE PROCEDURE proc_noop() LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE SCHEMA app;
  CREATE TABLE app.thing (id integer PRIMARY KEY);
  CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
  CREATE FUNCTION app.thing_count() RETURNS integer LANGUAGE sql AS $$ SELECT count(*)::int FROM app.thing $$;
  CREATE FUNCTION app.item_count(p integer) RETURNS integer LANGUAGE sql AS $$ SELECT p $$;
  CREATE FUNCTION app.item_count(p_label text) RETURNS integer LANGUAGE sql AS $$ SELECT length(p_label) $$;
  -- Drives the signature-help and PL/pgSQL body-completion checks: modes with
  -- named parameters and a DECLARE block.
  CREATE FUNCTION calc_stats(
    IN p_value integer,
    OUT p_total integer,
    INOUT p_note text
  ) LANGUAGE plpgsql AS $$
  DECLARE
    local_sum integer := 0;
    local_note text;
  BEGIN
    p_total := p_value + local_sum;
    p_note := local_note;
  END
  $$;
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

  console.log('\n== Sequences section ==')
  {
    // The section header appears with its count and a typed search finds it.
    const header = await page.waitFor(
      `[...document.querySelectorAll('.group h3')].some((h) => h.textContent.includes('Sequences'))`,
      { timeout: 15000 },
    ).then(() => true).catch(() => false)
    ok('Sequences section listed', header)
    const typed = async (text) => {
      await page.evaluate(`
        const input = document.querySelector('.browser-search input')
        input.value = ${JSON.stringify(text)}
        input.dispatchEvent(new Event('input', { bubbles: true }))
      `)
      await new Promise((r) => setTimeout(r, 250))
      return page.evaluate(`
        return [...document.querySelectorAll('.group')]
          .filter((g) => g.offsetParent !== null)
          .map((g) => g.querySelector('h3')?.textContent?.trim().split('\\n')[0]?.trim())
      `)
    }
    eq('typed search seq filters to the Sequences section', await typed('seq counter'), ['Sequences 1/4'])
    await page.evaluate(`
      const input = document.querySelector('.browser-search input')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    `)
    // Open the section and read the row.
    ok('sequence found in the tree', await openDdl('item_counter', 'Sequences'))
    await page.waitFor(`window.__pgdev && window.__pgdev.getValue().includes('CREATE SEQUENCE')`, { timeout: 15000 })
    eq('sequence tab is editable', await page.evaluate(`return window.__pgdev.getReadOnly()`), false)
    const detail = await page.evaluate(`
      // Expand the row's caret, then read the detail child.
      const row = [...document.querySelectorAll('.node')]
        .find((n) => n.querySelector('.obj-name')?.textContent?.trim() === 'item_counter')
      row?.querySelector('.caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 300))
      return [...row.closest('.tree').querySelectorAll('.node')]
        .some((n) => n.querySelector('.obj-name')?.textContent?.includes('inc 10'))
    `)
    ok('sequence detail shows increment and start', detail === true, String(detail))
  }


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

  console.log('\n== F5 and Ctrl+Enter run the query ==')
  {
    const pressKey = async (key, code, vk, modifiers = 0) => {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
    const resultShown = (value) => page.waitFor(
      `[...document.querySelectorAll('.grid-cell')].some((c) => c.textContent.trim() === ${JSON.stringify(value)})`,
      { timeout: 15000 },
    ).then(() => true).catch(() => false)

    // The double-click above left a fresh, editable query tab active.
    await page.evaluate(`
      window.__f5Sentinel = 'alive'
      window.__f5DefaultPrevented = null
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F5') window.__f5DefaultPrevented = e.defaultPrevented
      })
      window.__pgdev.setValue('SELECT 11 AS f5_probe')
      window.__pgdev.editor.focus()
    `)
    await pressKey('F5', 'F5', 116)
    ok('F5 runs the query', await resultShown('11'))
    eq('F5 does not reach the browser (no refresh)', await page.evaluate(`return window.__f5Sentinel`), 'alive')
    // A handled keybinding either stops propagation before the window listener
    // (null) or reaches it already prevented (true). `false` means it was let
    // through, which is what lets the browser reload.
    ok('F5 is consumed by the editor',
      (await page.evaluate(`return window.__f5DefaultPrevented`)) !== false,
      String(await page.evaluate(`return window.__f5DefaultPrevented`)))

    await page.evaluate(`
      window.__pgdev.setValue('SELECT 22 AS ctrl_probe')
      window.__pgdev.editor.focus()
    `)
    await pressKey('Enter', 'Enter', 13, 2)
    ok('Ctrl+Enter still runs the query', await resultShown('22'))
  }


  console.log('\n== IntelliSense lists objects without exact duplicates ==')
  {
    await page.evaluate(`window.__pgdev.setValue('SELECT ')`)
    const result = await page.evaluate(`
      const items = window.__pgdev.suggestions()
      const keys = items.map((i) => [i.label, i.description ?? '', i.labelDetail ?? '', i.detail ?? '', i.insertText ?? ''].join('|'))
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


  console.log('\n== AI bridge ==')
  {
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

    // A second agent query appends to the same read-only log: never a duplicate
    // "AI" tab, no row-edit affordance, and Run stays disabled.
    const read2 = await aiTool('query', { sql: 'SELECT 7 AS second' })
    eq('a second agent query is mirrored too', read2.body.result?.results?.[0]?.rows, [[7]])
    const aiCount = await page.evaluate(
      `return [...document.querySelectorAll('.tabstrip .tab-title')].filter((t) => t.textContent.trim().replace(/ \\*$/, '') === 'AI').length`,
    )
    eq('the AI log is never duplicated', aiCount, 1)
    const logText = await page.evaluate(`return window.__pgdev.getValue()`)
    ok('the AI log accumulates every query',
      logText.includes('SELECT 42 AS answer') && logText.includes('SELECT 7 AS second'),
      JSON.stringify(logText))
    ok('the AI log is read-only', await page.evaluate(`return window.__pgdev.getReadOnly()`))
    eq('the mirrored result has no row-edit buttons',
      await page.evaluate(`return document.querySelectorAll('.rowedit-open').length`), 0)
    ok('Run is disabled in the AI log', await page.evaluate(
      `return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run')?.disabled === true`,
    ))

    // The agent manages the tabs it opened: list and close. Tab
    // activate/dirty/foreign refusals are covered by the webai unit suite.
    await aiTool('open_query_tab', { sql: '-- tab one', title: 'tab_one' })
    const two = await aiTool('open_query_tab', { sql: '-- tab two', title: 'tab_two' })
    const listed = await aiTool('list_tabs')
    const names = (listed.body.result?.tabs ?? []).map((t) => t.title)
    ok('list_tabs shows the tabs the agent opened',
      names.includes('tab_one') && names.includes('tab_two'), JSON.stringify(names))
    const domTitles = await page.evaluate(
      `return [...document.querySelectorAll('.tabstrip .tab-title')].map((t) => t.textContent.trim().replace(/ \\*$/, ''))`,
    )
    ok('and none of the user tabs', domTitles.includes('Query 1') && !names.includes('Query 1'))

    const closed = await aiTool('close_tab', { tab: 'tab_two' })
    eq('a clean agent tab closes', closed.body.ok, true)
    const after = await aiTool('list_tabs')
    ok('it is gone afterwards',
      !(after.body.result?.tabs ?? []).some((t) => t.key === two.body.result?.key))
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

    // Open the first row: the dialog chrome, the locked key and the
    // initially-disabled SAVE prove the wiring; control-type mapping lives
    // in the celleditor unit suite.
    await page.evaluate(`document.querySelector('.rowedit-open')?.click()`)
    await page.waitFor(`!!document.querySelector('.rowedit-modal')`, { timeout: 10000 })
    const dialog = await page.evaluate(`
      const modal = document.querySelector('.rowedit-modal')
      const byName = (n) => [...modal.querySelectorAll('.rowedit-field')]
        .find((f) => f.querySelector('.rowedit-name')?.textContent === n)
      return {
        title: modal.querySelector('.rowedit-title')?.textContent,
        table: modal.querySelector('.rowedit-table')?.textContent,
        idLocked: !!byName('id')?.querySelector('.rowedit-locked'),
        payloadText: byName('payload')?.querySelector('textarea')?.value,
        saveDisabled: ${saveButton}?.disabled,
      }
    `)
    eq('dialog title and table', [dialog.title, dialog.table], ['Edit row', 'public.items'])
    eq('the primary key is locked', dialog.idLocked, true)
    eq('SAVE starts disabled', dialog.saveDisabled, true)

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
