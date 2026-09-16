/**
 * The Monaco model URI for a tab key. The whole key is percent-encoded: a
 * lossy sanitizer (`"a.b"` and `a_b` both folded to a_b) once let distinct
 * objects share one model URI, and the second `createModel` threw
 * ("ModelService: Cannot add model because it already exists!").
 * encodeURIComponent is URI-safe and injective, so distinct keys always get
 * distinct models.
 */
export function modelUri(key: string): string {
  return `inmemory://pgdev/${encodeURIComponent(key)}.sql`
}
