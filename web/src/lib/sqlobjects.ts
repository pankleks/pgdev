// Lookups shared by the hover and signature-help providers so overloads are
// ordered identically in both. Pure (no monaco / vue imports).

import type { FunctionInfo, SchemaData } from '../types'
import { normIdent } from '../monaco/sqlrefs'

/**
 * All overloads of `name` visible through the dotted chain, `public` first,
 * then other schemas in catalog order. A chain qualifier (`sch.f`) restricts
 * to that schema; built-ins only match when unqualified or `pg_catalog`.
 */
export function findFunctions(data: SchemaData, chain: string[], name: string): FunctionInfo[] {
  const qualifier = chain.slice(0, -1)
  const schema = qualifier.length ? normIdent(qualifier[qualifier.length - 1] as string) : ''
  const user = (data.functions ?? [])
    .filter((f) => f.name === name && (!schema || f.schema === schema))
    .sort((a, b) => {
      const byPublic = (a.schema === 'public' ? 0 : 1) - (b.schema === 'public' ? 0 : 1)
      return byPublic || a.schema.localeCompare(b.schema) || a.oid.localeCompare(b.oid)
    })
  const builtins =
    !schema || schema === 'pg_catalog' ? (data.builtins ?? []).filter((f) => f.name === name) : []
  return [...user, ...builtins]
}
