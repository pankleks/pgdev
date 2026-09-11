type Handler = () => void
type SelectionGetter = () => string | undefined

let formatHandler: Handler | null = null
let selectionGetter: SelectionGetter | null = null

export function setFormatHandler(f: Handler | null): void {
  formatHandler = f
}

export function triggerFormat(): void {
  formatHandler?.()
}

export function setSelectionGetter(g: SelectionGetter | null): void {
  selectionGetter = g
}

export function getActiveSelection(): string | undefined {
  return selectionGetter?.()
}
