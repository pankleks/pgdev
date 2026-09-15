type Handler = (values?: string) => void
type SelectionGetter = () => string | undefined
type InsertHandler = (text: string) => boolean

let formatHandler: (() => void) | null = null
let paramsHandler: Handler | null = null
let selectionGetter: SelectionGetter | null = null
let insertHandler: InsertHandler | null = null

export function setFormatHandler(f: (() => void) | null): void {
  formatHandler = f
}

export function triggerFormat(): void {
  formatHandler?.()
}

export function setParamsHandler(h: Handler | null): void {
  paramsHandler = h
}

export function triggerParamMap(values?: string): void {
  paramsHandler?.(values)
}

export function setSelectionGetter(g: SelectionGetter | null): void {
  selectionGetter = g
}

export function getActiveSelection(): string | undefined {
  return selectionGetter?.()
}

/** The AI bridge inserts inside the mounted editor; false when none is mounted. */
export function setInsertHandler(h: InsertHandler | null): void {
  insertHandler = h
}

export function insertAtCursor(text: string): boolean {
  return insertHandler?.(text) ?? false
}
