type Handler = () => void

let handler: Handler | null = null

export function setFormatHandler(f: Handler | null): void {
  handler = f
}

export function triggerFormat(): void {
  handler?.()
}
