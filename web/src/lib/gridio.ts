export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function formatCellForDisplay(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  return cellToText(value)
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function toDelimited(columns: string[], rows: unknown[][], separator: ',' | '\t'): string {
  const cell = (v: unknown): string => {
    const s = cellToText(v)
    return separator === ',' ? csvEscape(s) : s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  }
  const lines = [columns.map((c) => cell(c)).join(separator)]
  for (const row of rows) {
    lines.push(row.map((v) => cell(v)).join(separator))
  }
  return lines.join('\n')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

export async function copyGrid(columns: string[], rows: unknown[][]): Promise<boolean> {
  return copyText(toDelimited(columns, rows, '\t'))
}

export function downloadCsv(columns: string[], rows: unknown[][], filename: string): void {
  const text = '\uFEFF' + toDelimited(columns, rows, ',')
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // Must be in the DOM for Safari/Firefox; delay revoke so the download can start.
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
