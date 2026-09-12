import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The version shown in the UI and returned by /api/version. Read from the
// workspace root manifest so a release only has to bump one place.
let cached: string | null = null

export function appVersion(): string {
  if (cached) return cached
  try {
    const url = new URL('../../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version?: string }
    cached = pkg.version ?? '0.0.0'
  } catch {
    // The manifest sits outside server/dist; a packaged layout may not carry it.
    cached = '0.0.0'
  }
  return cached
}
