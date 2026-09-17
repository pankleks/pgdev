// Lookups shared by the hover and signature-help providers so overloads are
// ordered identically in both. Pure (no monaco / vue imports). The function
// grouping and ordering live in the catalog index, built once per load.

import type { FunctionInfo, SchemaData } from '../types'
import { catalogFor } from './catalog'
import { normIdent } from '../monaco/sqlrefs'

/**
 * All overloads of `name` visible through the dotted chain, `public` first,
 * then other schemas in catalog order. A chain qualifier (`sch.f`) restricts
 * to that schema; built-ins only match when unqualified or `pg_catalog`.
 */
export function findFunctions(data: SchemaData, chain: string[], name: string): FunctionInfo[] {
  const qualifier = chain.slice(0, -1)
  const schema = qualifier.length ? normIdent(qualifier[qualifier.length - 1] as string) : ''
  const catalog = catalogFor(data)
  const user = (catalog.functionsByName.get(name) ?? []).filter((f) => !schema || f.schema === schema)
  const builtins =
    !schema || schema === 'pg_catalog' ? (catalog.builtinsByName.get(name) ?? []) : []
  return [...user, ...builtins]
}
