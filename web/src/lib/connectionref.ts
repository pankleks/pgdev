/** Helpers for the stable numeric identifiers that deep links address via
 * `?connect=N`. A connection's number is assigned once, kept for the life of
 * the saved entry, and never reused — even after the entry is forgotten. */

export const CONNECT_PARAM = 'connect'

/** The number requested by a `?connect=N` URL, or null when absent/invalid. */
export function parseConnectNumber(search: string): number | null {
  const raw = new URLSearchParams(search).get(CONNECT_PARAM)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** The largest number currently in use, or 0 when there is none. */
export function maxSeq(entries: { seq?: unknown }[]): number {
  let max = 0
  for (const entry of entries) {
    if (isPositiveInteger(entry.seq) && entry.seq > max) max = entry.seq
  }
  return max
}

/** Fill in missing numbers for entries saved before numbering existed. Existing
 * numbers are preserved; new ones continue above the current maximum. */
export function assignSeqs<T extends { seq?: unknown }>(entries: T[]): (T & { seq: number })[] {
  let next = maxSeq(entries)
  for (const entry of entries as (T & { seq?: number })[]) {
    if (!isPositiveInteger(entry.seq)) entry.seq = ++next
  }
  return entries as (T & { seq: number })[]
}
