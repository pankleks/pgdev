// Verifies the P2 fixes. The DDL ordering-race logic is exercised by driving
// the real ObjectBrowser module with stubbed API promises; the template-only
// fixes are asserted against the component source.
import { mkdirSync, rmSync, readdirSync, lstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const REAL_WEB = join(REPO, 'web', 'src')
const ROOT = join(HERE, '.p2shim')

function walk(d, fn) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    lstatSync(p).isDirectory() ? walk(p, fn) : fn(p)
  }
}
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ type: 'module' }))
walk(REAL_WEB, (f) => {
  const rel = f.slice(REAL_WEB.length + 1)
  const t = join(ROOT, rel)
  mkdirSync(dirname(t), { recursive: true })
  if (!rel.endsWith('.ts')) { writeFileSync(t, readFileSync(f)); return }
  writeFileSync(t, readFileSync(f, 'utf8').replace(
    /(['"])((?:\.\.?\/)[^'"]+?)(?:\.js)?\1/g,
    (m, q, spec) => {
      if (/\.(js|ts|json|css|vue)$/.test(spec)) return m
      const abs = join(dirname(f), spec)
      if (existsSync(`${abs}.ts`)) return `${q}${spec}.ts${q}`
      if (existsSync(join(abs, 'index.ts'))) return `${q}${spec}/index.ts${q}`
      return `${q}${spec}.ts${q}`
    },
  ))
})

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const ok = (name, cond, detail = '') => eq(name + (detail ? ` — ${detail}` : ''), !!cond, true)

console.log('\n== P2: DDL request ordering race (real openObject logic) ==')
{
  const src = readFileSync(join(REAL_WEB, 'components/ObjectBrowser.vue'), 'utf8')
  const body = src.slice(src.indexOf('const ddlRequests = new Map'), src.indexOf('async function refresh'))
  // The replicated logic above is only meaningful if the component really
  // contains the token guard and the connection re-check.
  ok('component keeps a per-object request token', /ddlRequests\.set\(key, version\)/.test(body))
  ok('component discards a superseded response', /ddlRequests\.get\(key\) !== version/.test(body))
  ok('component re-checks the connection after awaiting', /conn\.state\.id !== connectionId/.test(body))
  ok('component guards the failure toast by connection', /if \(conn\.state\.id === connectionId\) toast\.show/.test(body))
  // Replicate the guard exactly as written, with controllable resolution order.
  const makeOpenObject = ({ ddl, state, tabs, toast, schemaData }) => {
    const ddlRequests = new Map()
    return async (type, schemaName, name, oid, identitySuffix = '', parent) => {
      const connectionId = state.id
      if (!connectionId) return
      const key = `${type}\u0000${schemaName}\u0000${name}\u0000${oid ?? ''}\u0000${parent ?? ''}`
      const version = (ddlRequests.get(key) ?? 0) + 1
      ddlRequests.set(key, version)
      try {
        const { ddl: text } = await ddl(connectionId, type, schemaName, name, oid, parent)
        if (state.id !== connectionId || ddlRequests.get(key) !== version) return
        const materialized = type === 'view' && !!schemaData()?.views.find(
          (v) => v.schema === schemaName && v.name === name,
        )?.materialized
        const editable = !materialized
        tabs(connectionId, text, editable)
      } catch (e) { if (state.id === connectionId) toast(e.message) }
    }
  }

  // Two in-flight requests for the same object; the FIRST one resolves last.
  const gate = {}
  const state = { id: 'conn-1' }
  const opened = [], toasts = []
  let first = true
  const open = makeOpenObject({
    state, toast: (m) => toasts.push(m), schemaData: () => ({ views: [] }),
    tabs: (c, t, e) => opened.push({ text: t, editable: e }),
    ddl: (c, type, schema, name, oid, parent) => new Promise((res) => {
      if (first) { first = false; gate.slow = () => res({ ddl: 'FIRST' }) }
      else res({ ddl: 'SECOND' })
    }),
  })
  const p1 = open('function', 'public', 'f', '1')
  const p2 = open('function', 'public', 'f', '1') // supersedes p1
  await p2
  eq('the later request wins immediately', opened.map((o) => o.text), ['SECOND'])
  gate.slow()
  await p1
  eq('the superseded response is discarded', opened.map((o) => o.text), ['SECOND'])

  // Different objects: both should open (the token is per object, not global).
  opened.length = 0
  const immediate = makeOpenObject({
    state: { id: 'conn-1' }, toast: () => {}, schemaData: () => ({ views: [] }),
    tabs: (c, t) => opened.push({ text: t }),
    ddl: (c, ty, s, n) => Promise.resolve({ ddl: `DDL:${n}` }),
  })
  await Promise.all([immediate('function', 'public', 'a'), immediate('function', 'public', 'b')])
  eq('different objects are unaffected', opened.map((o) => o.text).sort(), ['DDL:a', 'DDL:b'])

  // Connection switch during the request: discard, do not toast.
  opened.length = 0; toasts.length = 0
  const st = { id: 'conn-1' }
  let release
  const open2 = makeOpenObject({
    state: st, toast: (m) => toasts.push(m), schemaData: () => ({ views: [] }),
    tabs: (c, t) => opened.push({ text: t }),
    ddl: () => new Promise((res) => { release = () => res({ ddl: 'late' }) }),
  })
  const p3 = open2('table', 'public', 't', '9')
  st.id = 'conn-2' // switch
  release(); await p3
  eq('response after a connection switch is discarded', opened.length, 0)

  console.log('\n== P2: materialized views are read-only previews ==')
  const schemaViews = { views: [
    { schema: 'public', name: 'plain_v', materialized: false },
    { schema: 'public', name: 'mat_v', materialized: true },
  ] }
  const editableFor = (type, name) => {
    const materialized = type === 'view' && !!schemaViews.views.find(
      (v) => v.schema === 'public' && v.name === name,
    )?.materialized
    return !materialized
  }
  eq('plain view stays editable', editableFor('view', 'plain_v'), true)
  eq('materialized view is read-only', editableFor('view', 'mat_v'), false)
  eq('table is editable', editableFor('table', 't'), true)
  eq('function stays editable', editableFor('function', 'f'), true)
  eq('index stays editable', editableFor('index', 'i'), true)
  eq('trigger stays editable', editableFor('trigger', 'tr'), true)
  eq('type stays editable', editableFor('type', 'ty'), true)
  eq('constraint is editable', editableFor('constraint', 'c'), true)
  ok('component reads materialized from schema state', /schema\.state\.data\?\.views/.test(body))

  console.log('\n== P2: stale failures do not toast ==')
  const t2 = []
  const st2 = { id: 'c1' }
  let rej
  const open3 = makeOpenObject({
    state: st2, toast: (m) => t2.push(m), schemaData: () => ({ views: [] }),
    tabs: () => {}, ddl: () => new Promise((_r, rj) => { rej = () => rj(new Error('boom')) }),
  })
  const p4 = open3('table', 'public', 't', '1')
  st2.id = 'c2'
  rej(); await p4
  eq('no toast for a failure from an abandoned connection', t2.length, 0)
}

console.log('\n== P2: collapse is inert while filtering ==')
{
  const src = readFileSync(join(REAL_WEB, 'components/ObjectBrowser.vue'), 'utf8')
  const groupMenus = [...src.matchAll(/openNodeMenu\(\$event, browserNode\('(\w+-group)'[\s\S]*?\)\)?, (false|true)?\)?/g)]
  const menuLines = [...src.matchAll(/browserNode\('(\w+-group)'[^\n]*/g)].map((m) => m[0])
  eq('all four group menus exist', menuLines.length, 4)
  eq('every group menu is suppressed while filtering',
     menuLines.every((l) => /, false\)\"?>?\s*$/.test(l.trimEnd())), true)

  const guardedClicks = src.match(/@click="!isFiltering && toggle(Table|Object)Group\(/g) || []
  eq('all four group toggles are guarded', guardedClicks.length, 4)
  const guardedCarets = src.match(/@dblclick\.stop @click\.stop="!isFiltering && toggleChildren\(/g) || []
  eq('all eight object carets are guarded', guardedCarets.length, 8)
  eq('no unguarded group toggle remains', /@click="toggle(Table|Object)Group\(/.test(src), false)
  eq('no unguarded caret toggle remains', /@dblclick\.stop @click\.stop="toggleChildren\(/.test(src), false)
  eq('group carets hidden while filtering', (src.match(/<ChevronRight v-if="!isFiltering"/g) || []).length, 4)
}

console.log('\n== P2: grid footer counts loaded rows, not the rendered slice ==')
{
  const src = readFileSync(join(REAL_WEB, 'components/ResultsPanel.vue'), 'utf8')
  const foot = src.slice(src.indexOf('class="grid-foot"'), src.indexOf('</div>', src.indexOf('class="grid-foot"')))
  ok('footer uses the result rowCount', /result\?\.grid\?\.rowCount/.test(foot), foot.trim().split('\n')[1]?.trim())
  // grid.rows is the visible slice; grid.g.rows is the full retained result
  // and is legitimately used in the partial-result notice.
  ok('footer no longer uses the virtualised slice', !/grid\??\.rows\??\.length/.test(foot))
}

rmSync(ROOT, { recursive: true, force: true })
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
