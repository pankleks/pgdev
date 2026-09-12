// Test entry point.
//
// The source-level suite needs nothing but the repository, so it always runs.
// The live-database suites (aggtest, typetest, apitest) each create and drop
// their own pgdev_* databases, so they need PGDEV_TEST_URL and are skipped —
// with a clear notice rather than a failure — when it is unset.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function run(file) {
  console.log(`\n${'='.repeat(72)}\n${file}\n${'='.repeat(72)}`)
  const res = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' })
  if (res.error) throw res.error
  return res.status === 0
}

let ok = run('p2verify.mjs')

if (!process.env.PGDEV_TEST_URL) {
  console.log(`\n${'='.repeat(72)}`)
  console.log('SKIPPED: aggtest.mjs, typetest.mjs, apitest.mjs')
  console.log('PGDEV_TEST_URL is not set, so the live-database suites did not run.')
  console.log('Set it to a PostgreSQL server where databases may be created, e.g.')
  console.log('  PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test')
  console.log('They create and drop their own pgdev_* databases; never aim them at')
  console.log('a database you care about. The database they connect to is not modified.')
  console.log('='.repeat(72))
} else {
  for (const file of ['aggtest.mjs', 'typetest.mjs', 'apitest.mjs']) {
    if (!run(file)) ok = false
  }
}

console.log(`\n${ok ? 'ALL SUITES PASSED' : 'SOME SUITES FAILED'}`)
process.exit(ok ? 0 : 1)
