// Minimal Chrome DevTools Protocol client — no dependencies. Node's global
// WebSocket and fetch are enough to launch Chrome, attach to a page and drive
// it, which keeps the browser suite as light as the rest.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launchChrome({ port = 9333, headless = true, url = 'about:blank' } = {}) {
  const exe = process.env.CHROME_PATH || findChrome()
  if (!exe) throw new Error('no Chrome binary found; set CHROME_PATH')
  const profile = mkdtempSync(join(tmpdir(), 'pgdev-chrome-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Without these the renderer cannot start in a sandboxed/CI environment
    // and page-level CDP commands (Runtime, Page) never answer, while
    // browser-level ones still do — which is a confusing way to fail.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    url,
  ]
  // Chrome needs network access to reach the app under test. In a locked-down
  // sandbox its renderer starts but every fetch fails, so failures surface as
  // a blank page rather than an obvious error.
  if (headless) args.unshift('--headless=new')
  const child = spawn(exe, args, { stdio: 'ignore' })

  // wait for the debugging endpoint
  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) { version = await res.json(); break }
    } catch { /* not up yet */ }
    await sleep(250)
  }
  if (!version) {
    child.kill('SIGKILL')
    throw new Error('Chrome did not expose a debugging endpoint')
  }
  return {
    browserVersion: version.Browser,
    async close() {
      child.kill('SIGKILL')
      await sleep(200)
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

/** Attach to the first page target Chrome opened. */
export async function openPage(port) {
  let target = null
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const list = await res.json()
    target = list.find((t) => t.type === 'page')
    if (target) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!target) throw new Error('no page target found')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const consoleErrors = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      const frame = d?.stackTrace?.callFrames?.[0]
      consoleErrors.push(
        `[${frame?.url ?? '?'}:${(frame?.lineNumber ?? -1) + 1}:${(frame?.columnNumber ?? -1) + 1}] ` +
          (d?.exception?.description ?? d?.text ?? 'exception'),
      )
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      // A guard `window.confirm` blocks the page and every later evaluate
      // forever; dismiss dialogs so a surprised test fails on behaviour
      // instead of hanging the whole run.
      ws.send(JSON.stringify({ id: nextId++, method: 'Page.handleJavaScriptDialog', params: { accept: false } }))
    }
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Runtime.enable')
  await send('Page.enable')

  /** Evaluate an expression in the page, awaiting promises, returning JSON. */
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }

  const waitFor = async (expression, { timeout = 15000, interval = 150 } = {}) => {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      try {
        last = await evaluate(`return (${expression})`)
        if (last) return last
      } catch (e) { last = e.message }
      await sleep(interval)
    }
    throw new Error(`timed out waiting for: ${expression} (last: ${JSON.stringify(last)})`)
  }

  return {
    evaluate,
    waitFor,
    consoleErrors,
    close: async () => { ws.close() },
  }
}
