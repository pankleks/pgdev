import { Query, type PoolClient, type QueryResult, type QueryArrayConfig } from 'pg'

export interface BoundedResult {
  result: QueryResult<unknown[]>
  rows: unknown[][]
  totalRowCount: number
}

/** Execute once and drain the result without accumulating every row in pg. */
export function boundedQuery(client: PoolClient, sql: string, cap: number): Promise<BoundedResult> {
  return new Promise((resolve, reject) => {
    // A row listener with no callback disables node-postgres's internal row
    // accumulation. Slicing the result of a promise-based query is too late.
    const config: QueryArrayConfig = { text: sql, rowMode: 'array' }
    const query = new Query<unknown[]>(config)
    const rows: unknown[][] = []
    let totalRowCount = 0
    query.on('row', (row: unknown[]) => {
      totalRowCount++
      if (rows.length < cap) rows.push(row)
    })
    query.once('error', reject)
    query.once('end', (result: QueryResult<unknown[]>) => {
      resolve({ result, rows, totalRowCount })
    })
    // Keep draining after reaching the display limit: cancelling or closing
    // here would change mutation semantics and could hide a later SQL error.
    client.query(query)
  })
}
