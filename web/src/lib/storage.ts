import type { FileHandle } from './files'
import type { TabSession } from './tabsession'
import { sanitizeSession } from './tabsession'

// Browser persistence is IndexedDB-only. When IndexedDB is unavailable (or a
// write fails) the app keeps running on defaults and in-memory state: saved
// connections silently stop persisting, and the pinned-file save rejects so
// the caller can warn instead of reporting a save that never happened.

export interface StoredPinnedFile {
  id: string
  order: number
  fileName: string
  content: string
  handle?: FileHandle
}

export interface StoredConnections {
  saved: unknown
  last: unknown
  /** High-water mark for connection numbers, so a forgotten number is never
   * handed to a different connection. */
  nextSeq?: number
}

export interface StoredAppState {
  settings: unknown
  connections: StoredConnections | undefined
  pinnedFiles: StoredPinnedFile[]
}

interface SettingsRecord {
  id: 'current'
  value: unknown
}

interface ConnectionsRecord {
  id: 'current'
  saved: unknown
  last: unknown
  nextSeq?: number
}

const DB_NAME = 'pgdev'
const DB_VERSION = 2
const SETTINGS_STORE = 'settings'
const CONNECTIONS_STORE = 'connections'
const PINNED_FILES_STORE = 'pinnedFiles'
const TABS_STORE = 'tabs'

type StoreName = typeof SETTINGS_STORE | typeof CONNECTIONS_STORE | typeof PINNED_FILES_STORE | typeof TABS_STORE

let databasePromise: Promise<IDBDatabase> | null = null
let writeQueue = Promise.resolve()

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'))
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) database.createObjectStore(SETTINGS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(CONNECTIONS_STORE)) database.createObjectStore(CONNECTIONS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(PINNED_FILES_STORE)) database.createObjectStore(PINNED_FILES_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(TABS_STORE)) database.createObjectStore(TABS_STORE, { keyPath: 'id' })
    }
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another browser tab'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
  })
}

function database(): Promise<IDBDatabase> {
  let p = databasePromise
  if (!p) {
    p = openDatabase()
    databasePromise = p
    // A failed open must not stay cached: a blocked or transiently
    // unavailable IndexedDB can come back (e.g. the blocking tab closes),
    // so drop the rejection and let the next caller retry.
    p.catch(() => {
      if (databasePromise === p) databasePromise = null
    })
  }
  return p
}

function getRecord<T>(db: IDBDatabase, storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${storeName}`))
  })
}

function getAllRecords<T>(db: IDBDatabase, storeName: StoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${storeName}`))
  })
}

function putRecord(db: IDBDatabase, storeName: StoreName, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not write ${storeName}`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not write ${storeName}`))
    transaction.objectStore(storeName).put(value)
  })
}

function replacePinnedFiles(db: IDBDatabase, pins: StoredPinnedFile[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PINNED_FILES_STORE, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not write ${PINNED_FILES_STORE}`))
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not write ${PINNED_FILES_STORE}`))

    const store = transaction.objectStore(PINNED_FILES_STORE)
    store.clear()
    for (const pin of pins) store.put(pin)
  })
}

function queueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation)
  writeQueue = result.then(() => undefined, () => undefined)
  return result
}

function isStoredPinnedFile(value: unknown): value is StoredPinnedFile {
  if (!value || typeof value !== 'object') return false
  const pin = value as Partial<StoredPinnedFile>
  return (
    typeof pin.id === 'string' &&
    typeof pin.order === 'number' &&
    typeof pin.fileName === 'string' &&
    typeof pin.content === 'string'
  )
}

async function loadStorage(): Promise<StoredAppState> {
  try {
    const db = await database()
    const [storedSettings, storedConnections, storedPins] = await Promise.all([
      getRecord<SettingsRecord>(db, SETTINGS_STORE, 'current'),
      getRecord<ConnectionsRecord>(db, CONNECTIONS_STORE, 'current'),
      getAllRecords<StoredPinnedFile>(db, PINNED_FILES_STORE),
    ])
    const connections = storedConnections
    return {
      settings: storedSettings?.value,
      connections: connections
        ? { saved: connections.saved, last: connections.last, nextSeq: connections.nextSeq }
        : undefined,
      pinnedFiles: storedPins.filter(isStoredPinnedFile),
    }
  } catch {
    // Keep the app usable when IndexedDB is unavailable: everything runs on
    // defaults and in-memory state, and saves below reject.
    return { settings: undefined, connections: undefined, pinnedFiles: [] }
  }
}

export const storageReady = loadStorage()

export function saveSettings(value: unknown): Promise<void> {
  return queueWrite(async () => {
    const db = await database()
    await putRecord(db, SETTINGS_STORE, { id: 'current', value } satisfies SettingsRecord)
  })
}

export function saveConnections(saved: unknown, last: unknown, nextSeq: number): Promise<void> {
  return queueWrite(async () => {
    const db = await database()
    await putRecord(db, CONNECTIONS_STORE, { id: 'current', saved, last, nextSeq } satisfies ConnectionsRecord)
  })
}

export function savePinnedFiles(pins: StoredPinnedFile[]): Promise<boolean> {
  return queueWrite(async () => {
    const withoutHandles = pins.map(({ handle: _handle, ...pin }) => pin)
    const db = await database()
    try {
      await replacePinnedFiles(db, pins)
      return true
    } catch {
      // File handles are structured-cloneable in supported browsers, but keep
      // the file snapshots if a browser rejects cloning a handle.
      await replacePinnedFiles(db, withoutHandles)
      return false
    }
  })
}

/** Persist the global tab session (user-created query tabs). A failed write
 * rejects so the caller can retry on its next interval tick. */
export function saveTabSession(session: TabSession): Promise<void> {
  return queueWrite(async () => {
    const db = await database()
    await putRecord(db, TABS_STORE, { id: 'current', ...session } satisfies { id: string } & TabSession)
  })
}

/**
 * The session restored at startup. Never throws: corrupt or unreadable data
 * simply means "nothing saved".
 */
export async function loadTabSession(): Promise<TabSession | null> {
  try {
    const db = await database()
    const record = await getRecord<{ id: string; tabs: unknown; activeIndex: unknown }>(db, TABS_STORE, 'current')
    return record ? sanitizeSession(record) : null
  } catch {
    return null
  }
}
