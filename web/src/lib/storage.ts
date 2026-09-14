import type { FileHandle } from './files'
import type { TabSession } from './tabsession'
import { sanitizeSession } from './tabsession'

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
}

const DB_NAME = 'pgdev'
const DB_VERSION = 2
const SETTINGS_STORE = 'settings'
const CONNECTIONS_STORE = 'connections'
const PINNED_FILES_STORE = 'pinnedFiles'
const TABS_STORE = 'tabs'

const LEGACY_SETTINGS_KEY = 'pgdev.settings'
const LEGACY_SAVED_CONNECTIONS_KEY = 'pgdev.savedConnections'
const LEGACY_LAST_CONNECTION_KEY = 'pgdev.lastConnection'
const LEGACY_PINNED_FILES_KEY = 'pgdev.pinnedFiles'
const LEGACY_TABS_KEY = 'pgdev.tabs'

type StoreName = typeof SETTINGS_STORE | typeof CONNECTIONS_STORE | typeof PINNED_FILES_STORE | typeof TABS_STORE

let databasePromise: Promise<IDBDatabase> | null = null
let writeQueue = Promise.resolve()
let indexedDbAvailable = false

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

interface LegacyValue {
  present: boolean
  value?: unknown
}

function readLegacyJson(key: string): LegacyValue {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return { present: false }
    return { present: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { present: true }
  }
}

function removeLegacy(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore unavailable browser storage.
  }
}

function writeLegacyJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore unavailable browser storage.
  }
}

/** The pinned-file fallback must know whether the write landed: unlike
 * writeLegacyJson it lets a quota or unavailable-storage error propagate. */
function writeLegacyJsonOrThrow(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
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

function parsePinnedFiles(value: unknown): StoredPinnedFile[] {
  if (!Array.isArray(value)) return []
  return value.filter(isStoredPinnedFile)
}

async function loadStorage(): Promise<StoredAppState> {
  const legacySettings = readLegacyJson(LEGACY_SETTINGS_KEY)
  const legacySavedConnections = readLegacyJson(LEGACY_SAVED_CONNECTIONS_KEY)
  const legacyLastConnection = readLegacyJson(LEGACY_LAST_CONNECTION_KEY)
  const legacyPinnedFiles = readLegacyJson(LEGACY_PINNED_FILES_KEY)

  try {
    const db = await database()
    indexedDbAvailable = true
    const storedSettings = await getRecord<SettingsRecord>(db, SETTINGS_STORE, 'current')
    const storedConnections = await getRecord<ConnectionsRecord>(db, CONNECTIONS_STORE, 'current')
    const storedPins = await getAllRecords<StoredPinnedFile>(db, PINNED_FILES_STORE)

    let settings = storedSettings?.value
    let connections = storedConnections
    let pinnedFiles = storedPins.filter(isStoredPinnedFile)
    const migratedKeys: string[] = []

    if (!storedSettings && legacySettings.value !== undefined) {
      settings = legacySettings.value
      await putRecord(db, SETTINGS_STORE, { id: 'current', value: settings } satisfies SettingsRecord)
      if (legacySettings.present) migratedKeys.push(LEGACY_SETTINGS_KEY)
    } else if (storedSettings && legacySettings.present && legacySettings.value !== undefined) {
      migratedKeys.push(LEGACY_SETTINGS_KEY)
    }

    if (!storedConnections && (legacySavedConnections.value !== undefined || legacyLastConnection.value !== undefined)) {
      connections = {
        id: 'current',
        saved: legacySavedConnections.value ?? [],
        last: legacyLastConnection.value ?? null,
      }
      await putRecord(db, CONNECTIONS_STORE, connections)
      if (legacySavedConnections.present && legacySavedConnections.value !== undefined) {
        migratedKeys.push(LEGACY_SAVED_CONNECTIONS_KEY)
      }
      if (legacyLastConnection.present && legacyLastConnection.value !== undefined) {
        migratedKeys.push(LEGACY_LAST_CONNECTION_KEY)
      }
    } else if (storedConnections) {
      if (legacySavedConnections.present && legacySavedConnections.value !== undefined) {
        migratedKeys.push(LEGACY_SAVED_CONNECTIONS_KEY)
      }
      if (legacyLastConnection.present && legacyLastConnection.value !== undefined) {
        migratedKeys.push(LEGACY_LAST_CONNECTION_KEY)
      }
    }

    if (!pinnedFiles.length) {
      const legacyPins = parsePinnedFiles(legacyPinnedFiles.value)
      if (legacyPins.length) {
        pinnedFiles = legacyPins
        await replacePinnedFiles(db, pinnedFiles)
        if (legacyPinnedFiles.present) migratedKeys.push(LEGACY_PINNED_FILES_KEY)
      }
    } else if (legacyPinnedFiles.present && parsePinnedFiles(legacyPinnedFiles.value).length) {
      migratedKeys.push(LEGACY_PINNED_FILES_KEY)
    }

    for (const key of migratedKeys) removeLegacy(key)

    return {
      settings,
      connections: connections
        ? { saved: connections.saved, last: connections.last }
        : undefined,
      pinnedFiles,
    }
  } catch {
    indexedDbAvailable = false
    // Keep the app usable in browsers where IndexedDB is unavailable. Legacy
    // values are intentionally left in place so a later retry can migrate them.
    return {
      settings: legacySettings.value,
      connections:
        legacySavedConnections.value !== undefined || legacyLastConnection.value !== undefined
          ? { saved: legacySavedConnections.value ?? [], last: legacyLastConnection.value ?? null }
          : undefined,
      pinnedFiles: parsePinnedFiles(legacyPinnedFiles.value),
    }
  }
}

export const storageReady = loadStorage()

export function saveSettings(value: unknown): Promise<void> {
  return queueWrite(async () => {
    if (!indexedDbAvailable) {
      writeLegacyJson(LEGACY_SETTINGS_KEY, value)
      return
    }
    const db = await database()
    await putRecord(db, SETTINGS_STORE, { id: 'current', value } satisfies SettingsRecord)
  })
}

export function saveConnections(saved: unknown, last: unknown): Promise<void> {
  return queueWrite(async () => {
    if (!indexedDbAvailable) {
      writeLegacyJson(LEGACY_SAVED_CONNECTIONS_KEY, saved)
      if (last === null) {
        try {
          localStorage.removeItem(LEGACY_LAST_CONNECTION_KEY)
        } catch {
          // Ignore unavailable browser storage.
        }
      } else {
        writeLegacyJson(LEGACY_LAST_CONNECTION_KEY, last)
      }
      return
    }
    const db = await database()
    await putRecord(db, CONNECTIONS_STORE, { id: 'current', saved, last } satisfies ConnectionsRecord)
  })
}

export function savePinnedFiles(pins: StoredPinnedFile[]): Promise<boolean> {
  return queueWrite(async () => {
    const withoutHandles = pins.map(({ handle: _handle, ...pin }) => pin)
    if (!indexedDbAvailable) {
      // No IndexedDB: the legacy key is the only home left. A failed write
      // rejects so the caller can warn instead of losing the pins silently.
      writeLegacyJsonOrThrow(LEGACY_PINNED_FILES_KEY, withoutHandles)
      return false
    }
    const db = await database()
    try {
      await replacePinnedFiles(db, pins)
      return true
    } catch {
      // File handles are structured-cloneable in supported browsers, but keep
      // the file snapshots if a browser rejects cloning a handle.
      try {
        await replacePinnedFiles(db, withoutHandles)
        return false
      } catch (idbError) {
        // Last resort before the pins are lost (e.g. quota): legacy
        // localStorage. If even that fails, the pins live only in memory —
        // surface the failure so the caller can warn instead of reporting a
        // save that never happened.
        try {
          writeLegacyJsonOrThrow(LEGACY_PINNED_FILES_KEY, withoutHandles)
        } catch (legacyError) {
          throw legacyError instanceof Error ? legacyError : idbError
        }
        return false
      }
    }
  })
}

/** Persist the global tab session (user-created query tabs). A failed write
 * rejects so the caller can retry on its next interval tick. */
export function saveTabSession(session: TabSession): Promise<void> {
  return queueWrite(async () => {
    if (!indexedDbAvailable) {
      writeLegacyJsonOrThrow(LEGACY_TABS_KEY, session)
      return
    }
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
    // storageReady sets indexedDbAvailable and runs the legacy migration;
    // awaiting it also keeps this first read from racing the module probe.
    await storageReady
    if (!indexedDbAvailable) return sanitizeSession(readLegacyJson(LEGACY_TABS_KEY).value)
    const db = await database()
    const record = await getRecord<{ id: string; tabs: unknown; activeIndex: unknown }>(db, TABS_STORE, 'current')
    return record ? sanitizeSession(record) : null
  } catch {
    return null
  }
}
