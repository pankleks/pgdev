// Test entry point.
//
// The unit and source-level suites need nothing but the repository, so they
// always run. The live-database suites (aggtest, ddl, typetest, apitest) each
// create and drop their own pgdev_* databases, so they need PGDEV_TEST_URL and
// are skipped — with a clear notice rather than a failure — when it is unset.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

// Needed here to decide whether the database suites can run at all; the suites
// load it themselves too, so a single suite works when run directly.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  // no .env: the skip notice below explains what to set
}

function run(file, args = []) {
  console.log(`\n${'='.repeat(72)}\n${file}\n${'='.repeat(72)}`)
  const res = spawnSync(process.execPath, [join(HERE, file), ...args], { stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) console.log(`  [runner] ${file} exited ${res.status} signal=${res.signal}`)
  return res.status === 0
}

/** Unit suites run under node:test, one process per file. */
function runUnit() {
  const files = readdirSync(join(HERE, 'unit'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => join('unit', f))
  console.log(`\n${'='.repeat(72)}\nnode --test unit/  (${files.length} files)\n${'='.repeat(72)}`)
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: HERE, stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) console.log(`  [runner] unit exited ${res.status}`)
  return res.status === 0
}

let ok = runUnit()
for (const file of ['p2verify.mjs']) {
  if (!run(file)) ok = false
}

const DATABASE_SUITES = ['aggtest.mjs', 'typetest.mjs', join('db', 'ddl.mjs'), join('db', 'tableedit.mjs'), 'apitest.mjs']

if (!process.env.PGDEV_TEST_URL) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`SKIPPED: ${DATABASE_SUITES.join(', ')}`)
  console.log('PGDEV_TEST_URL is not set, so the live-database suites did not run.')
  console.log('Set it to a PostgreSQL server where databases may be created, e.g.')
  console.log('  PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test')
  console.log('They create and drop their own pgdev_* databases; never aim them at')
  console.log('a database you care about. The database they connect to is not modified.')
  console.log('='.repeat(72))
} else {
  for (const file of DATABASE_SUITES) {
    if (!run(file)) ok = false
  }
  if (process.env.PGDEV_BROWSER) {
    if (!run(join('browser', 'app.mjs'))) ok = false
  } else {
    console.log(`\n${'='.repeat(72)}`)
    console.log('SKIPPED: browser/app.mjs')
    console.log('Set PGDEV_BROWSER=1 to drive Chrome. It needs a Chrome binary, and it')
    console.log('starts its own API + Vite on ports 3000/5173, so those must be free.')
    console.log('The origin guard only permits that exact cross-port pair.')
    console.log('='.repeat(72))
  }
}

console.log(`\n${ok ? 'ALL SUITES PASSED' : 'SOME SUITES FAILED'}`)
process.exit(ok ? 0 : 1)
