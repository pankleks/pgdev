// Per-schema-load index over the loaded catalog, shared by every IntelliSense
// provider. Without it, each keystroke re-scans relations linearly, re-filters
// and re-sorts functions, and rebuilds the schema set. The index is rebuilt
// only when the schema data object is replaced (a fresh load), keyed by
// identity exactly like the old relations cache.
import type { FunctionInfo, SchemaData, SequenceInfo, TableInfo, TypeInfo, ViewInfo } from '../types'
import { normIdent, type RelRef } from '../monaco/sqlrefs'
import type { QueryScope, ScopeRelation } from '../monaco/sqlscope'

export type CatalogRelation = TableInfo | ViewInfo
/** A catalog relation or a synthetic CTE/derived one. */
export type Relation = CatalogRelation | ScopeRelation

export interface SchemaObjects {
  tables: TableInfo[]
  views: ViewInfo[]
  types: TypeInfo[]
  sequences: SequenceInfo[]
  functions: FunctionInfo[]
}

export interface Catalog {
  /** Tables and views, in catalog order, for the unfiltered fallback list. */
  relations: CatalogRelation[]
  /** Lookup by exact `schema\u0000name`. */
  byKey: Map<string, CatalogRelation>
  /** Lookup by bare name; several schemas may share one. */
  byName: Map<string, CatalogRelation[]>
  schemas: string[]
  bySchema: Map<string, SchemaObjects>
  /** User functions grouped by name, pre-sorted public-first. */
  functionsByName: Map<string, FunctionInfo[]>
  /** Built-ins grouped by name, in catalog order. */
  builtinsByName: Map<string, FunctionInfo[]>
}

function key(schema: string, name: string): string {
  return `${schema}\u0000${name}`
}

function push<T>(map: Map<string, T[]>, k: string, value: T): void {
  const list = map.get(k)
  if (list) list.push(value)
  else map.set(k, [value])
}

function functionOrder(a: FunctionInfo, b: FunctionInfo): number {
  const byPublic = (a.schema === 'public' ? 0 : 1) - (b.schema === 'public' ? 0 : 1)
  return byPublic || a.schema.localeCompare(b.schema) || a.oid.localeCompare(b.oid)
}

let cached: { data: SchemaData; catalog: Catalog } | null = null

export function catalogFor(data: SchemaData): Catalog {
  if (cached?.data === data) return cached.catalog

  const relations: CatalogRelation[] = []
  const byKey = new Map<string, CatalogRelation>()
  const byName = new Map<string, CatalogRelation[]>()
  const schemas = new Set<string>()
  const bySchema = new Map<string, SchemaObjects>()
  const functionsByName = new Map<string, FunctionInfo[]>()
  const builtinsByName = new Map<string, FunctionInfo[]>()

  const bucket = (schema: string): SchemaObjects => {
    let entry = bySchema.get(schema)
    if (!entry) {
      entry = { tables: [], views: [], types: [], sequences: [], functions: [] }
      bySchema.set(schema, entry)
    }
    return entry
  }
  const store = (relation: CatalogRelation): void => {
    relations.push(relation)
    byKey.set(key(relation.schema, relation.name), relation)
    push(byName, relation.name, relation)
    schemas.add(relation.schema)
  }

  for (const table of data.tables) {
    store(table)
    bucket(table.schema).tables.push(table)
  }
  for (const view of data.views) {
    store(view)
    bucket(view.schema).views.push(view)
  }
  for (const type of data.types) {
    schemas.add(type.schema)
    bucket(type.schema).types.push(type)
  }
  for (const sequence of data.sequences) {
    schemas.add(sequence.schema)
    bucket(sequence.schema).sequences.push(sequence)
  }
  for (const fn of data.functions) {
    schemas.add(fn.schema)
    bucket(fn.schema).functions.push(fn)
    push(functionsByName, fn.name, fn)
  }
  for (const list of functionsByName.values()) list.sort(functionOrder)
  for (const fn of data.builtins ?? []) push(builtinsByName, fn.name, fn)

  const catalog: Catalog = {
    relations,
    byKey,
    byName,
    schemas: [...schemas],
    bySchema,
    functionsByName,
    builtinsByName,
  }
  cached = { data, catalog }
  return catalog
}

export function findCatalogRelation(catalog: Catalog, ref: RelRef): CatalogRelation | undefined {
  if (ref.schema) return catalog.byKey.get(key(ref.schema, ref.name))
  const matches = catalog.byName.get(ref.name)
  if (!matches?.length) return undefined
  // Completion metadata does not contain search_path. Prefer public, then a
  // unique match; never guess among several non-public schemas.
  return matches.find((r) => r.schema === 'public') ?? (matches.length === 1 ? matches[0] : undefined)
}

/** Resolve an alias reference, which may name a CTE or derived relation. */
export function referenceRelation(
  catalog: Catalog,
  synthetic: readonly ScopeRelation[],
  ref: RelRef,
): Relation | undefined {
  if (ref.name.startsWith('\u0000')) return synthetic.find((r) => r.name === ref.name)
  return findCatalogRelation(catalog, ref)
}

/** Resolve a dotted qualifier (`e`, `sch.tbl`) to a relation. */
export function resolveRelation(
  catalog: Catalog,
  synthetic: readonly ScopeRelation[],
  parts: string[],
  aliases: Map<string, RelRef>,
): Relation | undefined {
  if (!parts.length) return undefined
  const name = normIdent(parts[parts.length - 1] as string)
  if (parts.length > 1) {
    return catalog.byKey.get(key(normIdent(parts[parts.length - 2] as string), name))
  }
  const ref = aliases.get(name)
  if (ref) return referenceRelation(catalog, synthetic, ref)
  // A known alias owns its qualifier even when its target is missing. Once a
  // query declares sources, a bare catalog table outside that namespace is not
  // a usable qualifier; keep discovery for a statement with no FROM.
  if (aliases.size) return undefined
  return findCatalogRelation(catalog, { schema: '', name })
}

/** Relations whose columns are offered unqualified at the cursor. */
export function visibleRelations(
  catalog: Catalog,
  synthetic: readonly ScopeRelation[],
  scope: QueryScope,
): Relation[] {
  if (!scope.hasRelations) return [...catalog.relations, ...synthetic]
  const seen = new Set<Relation>()
  const out: Relation[] = []
  for (const ref of scope.aliases.values()) {
    const relation = referenceRelation(catalog, synthetic, ref)
    if (relation && !seen.has(relation)) {
      seen.add(relation)
      out.push(relation)
    }
  }
  return out
}
