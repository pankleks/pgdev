type Handler = (values?: string) => void
type SelectionGetter = () => string | undefined

let formatHandler: (() => void) | null = null
let paramsHandler: Handler | null = null
let selectionGetter: SelectionGetter | null = null

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
