// Loads the application sources from plain Node, for unit tests.
//
// The sources use module specifiers Node cannot resolve on its own: server
// files use NodeNext `.js` specifiers that only exist after `tsc`, and web
// files use extensionless specifiers intended for Vite. Rather than change the
// sources, copy both trees into a scratch directory with the specifiers
// retargeted at the `.ts` files, which Node's type stripping can execute.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SHIM_ROOT = join(HERE, '..', '.shim')
const SHIM = join(SHIM_ROOT, String(process.pid))

const TREES = [
  ['server/src', join(SHIM, 'server')],
  ['web/src', join(SHIM, 'web')],
]

function copyTree(srcDir, destDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const from = join(dir, entry)
      if (lstatSync(from).isDirectory()) { walk(from); continue }
      const to = join(destDir, relative(srcDir, from))
      mkdirSync(dirname(to), { recursive: true })
      if (!from.endsWith('.ts')) {
        writeFileSync(to, readFileSync(from))
        continue
      }
      const rewritten = readFileSync(from, 'utf8').replace(
        /(['"])((?:\.\.?\/)[^'"]+?)(?:\.js)?\1/g,
        (match, quote, spec) => {
          if (/\.(js|ts|json|css|vue)$/.test(spec)) return match
          const abs = join(dirname(from), spec)
          if (existsSync(`${abs}.ts`)) return `${quote}${spec}.ts${quote}`
          if (existsSync(join(abs, 'index.ts'))) return `${quote}${spec}/index.ts${quote}`
          return `${quote}${spec}.ts${quote}`
        },
      )
      writeFileSync(to, rewritten)
    }
  }
  walk(srcDir)
}

let built = null

/** Remove scratch trees whose owning process is gone, and this one's on exit. */
function sweepStaleShims() {
  let entries = []
  try { entries = readdirSync(SHIM_ROOT) } catch { return }
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      // still running — leave its tree alone
    } catch {
      rmSync(join(SHIM_ROOT, entry), { recursive: true, force: true })
    }
  }
}

/** Build this process's scratch tree once. */
export function sourceLoader() {
  if (!built) {
    built = (async () => {
      mkdirSync(SHIM_ROOT, { recursive: true })
      sweepStaleShims()
      rmSync(SHIM, { recursive: true, force: true })
      mkdirSync(SHIM, { recursive: true })
      writeFileSync(join(SHIM, 'package.json'), JSON.stringify({ type: 'module' }))
      for (const [src, dest] of TREES) copyTree(join(REPO, src), dest)
      const cleanup = () => {
        rmSync(SHIM, { recursive: true, force: true })
        try { if (readdirSync(SHIM_ROOT).length === 0) rmSync(SHIM_ROOT, { recursive: true, force: true }) } catch { /* gone */ }
      }
      process.on('exit', cleanup)
    })()
  }
  return async (spec) => {
    await built
    return import(join(SHIM, spec))
  }
}
