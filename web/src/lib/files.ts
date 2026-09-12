export interface WritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
}

export interface FileHandle {
  readonly name: string
  createWritable(): Promise<WritableFileStream>
}

export interface OpenFileHandle extends FileHandle {
  getFile(): Promise<File>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}

interface OpenFilePickerOptions {
  multiple?: boolean
  types?: { description: string; accept: Record<string, string[]> }[]
}

interface FilePickerWindow extends Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileHandle>
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<OpenFileHandle[]>
}

export interface SavedFile {
  fileName: string
  handle?: FileHandle
}

const SQL_SAVE_TYPES = [{ description: 'SQL script', accept: { 'application/sql': ['.sql'] } }]
const SQL_OPEN_TYPES = [
  { description: 'SQL/text script', accept: { 'application/sql': ['.sql'], 'text/plain': ['.txt', '.ddl'] } },
]

function pickerWindow(): FilePickerWindow {
  return window as FilePickerWindow
}

export function isPickerCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function downloadText(content: string, fileName: string): SavedFile {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/sql;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return { fileName }
}

export async function saveTextFile(
  content: string,
  suggestedName: string,
  existingHandle?: FileHandle,
  pickName = !existingHandle,
): Promise<SavedFile | null> {
  const win = pickerWindow()
  let handle = pickName ? undefined : existingHandle

  if (!handle && pickName && win.showSaveFilePicker) {
    try {
      handle = await win.showSaveFilePicker({ suggestedName, types: SQL_SAVE_TYPES })
    } catch (error) {
      if (isPickerCancelled(error)) return null
      throw error
    }
  }

  if (!handle) return downloadText(content, suggestedName)

  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
  return { fileName: handle.name || suggestedName, handle }
}

export async function openTextFiles(): Promise<{ file: File; handle?: OpenFileHandle }[] | null> {
  const win = pickerWindow()
  if (!win.showOpenFilePicker) return null

  let handles: OpenFileHandle[]
  try {
    handles = await win.showOpenFilePicker({ multiple: true, types: SQL_OPEN_TYPES })
  } catch (error) {
    if (isPickerCancelled(error)) return []
    throw error
  }

  return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })))
}
