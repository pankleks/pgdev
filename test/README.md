# Tests

`npm test` runs every suite. `test/run.mjs` is the entry point: it always runs
the suite that needs no database, and runs the live-database suites only when
`PGDEV_TEST_URL` is set — skipping them with a notice rather than failing when
it is not.

```bash
npm test                                                          # unit + component only
PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test    # + live database
PGDEV_TEST_URL=... PGDEV_BROWSER=1 npm test                        # + browser
```

`npm test` rebuilds `server/dist` first, because the database suites import the
compiled output rather than the TypeScript sources. Individual suites run the
same way:

```bash
node test/p2verify.mjs
PGDEV_TEST_URL=... node test/apitest.mjs
```

## Suites

| File | Needs a database | Covers |
| --- | --- | --- |
| `p2verify.mjs` | no | Component logic and template guards: the DDL request ordering token (later click wins, superseded and post-switch responses discarded, distinct objects unaffected), materialized views staying read-only, collapse being inert while filtering, and the grid footer reporting loaded rows. |
| `aggtest.mjs` | yes | Aggregate DDL round-trips: plain, `SORTOP`, moving-aggregate, ordered-set, hypothetical-set, `SSPACE`, empty-string `INITCOND`, schema-qualified function/operator references, plus the built-ins `array_agg`, `sum`, `avg` and `max`, which must re-apply from generated text. |
| `typetest.mjs` | yes | Range types (plain, explicit multirange name, explicit collation), composite attribute `COLLATE`, domain constraint names and domain `COLLATE`, and sub-partitioned children including their grandchildren. |
| `apitest.mjs` | yes | The documented HTTP surface end to end: connect, `/schema` (user objects with function arguments and comments, plus the filtered built-in function list for completion and hover), `/ddl` for every object type, query execution, multi-statement batches, cursor paging across a 2,500-row result, error and SQLSTATE reporting, the 30s statement timeout, cancellation, disconnecting while a query runs, the dedicated catalog pool surviving fully-pinned paging sessions, `VACUUM` autocommit handling, `maxRows` validation, DDL execution through the query tool, manual transactions spanning runs (rollback, chained commit, aborted transactions, tab-close rollback), the row editor (`editable` metadata present/absent, a single-row UPDATE with `RETURNING` transport, NULL, temporal and array-literal writes, every rejection, row-not-found, and saves joining an open transaction), the AI tool surface (missing and wrong tokens rejected, a read-only `query` returning rows on the open connection without a browser window, a write refused by the classifier, a data-modifying CTE refused by the read-only transaction, filtered `get_schema`/`get_ddl`, the no-window editor error, an unknown bridge result ignored, no `list_connections`/`run_active_query`, `get_active_result` needing a window, the limits endpoint validating its range and applying a changed row limit to the next `query`, and a fresh server with nothing connected reporting it is not connected), disconnect, and the origin guard. |
| `db/ddl.mjs` | yes | DDL round-trips for RLS (enable/force, permissive and restrictive, roles, `USING`/`WITH CHECK`), list and hash partitions including `DEFAULT`, partition-local constraints and indexes, index variants (partial, expression, `INCLUDE`, gin, brin, unique), constraint variants (`NOT VALID`, deferred, `ON DELETE`/`ON UPDATE`), foreign-key variants (`MATCH FULL`, `NOT VALID`, `SET NULL` columns), column `COLLATE`, primary-key `INCLUDE`, `INHERITS`, view/materialized-view attributes, foreign-table FDW options, composite and enum types, and regeneration over every harvested table. |
| `db/tableedit.mjs` | yes | The table editor end to end: change every editable property at once (rename, type, varchar length, numeric precision/scale, nullability, defaults, add/drop column, column and table comments), assert the change-only ALTER clauses and their drops→renames→alters→adds→comments order, apply the script and compare the result to an independently created expected table by column fingerprint; plus no-op, locked/PK guards, stale-fingerprint 409, and non-table (view/partition) rejection. |
| `unit/*.test.mjs` | no | `node:test` suites for the pure logic: the statement splitter, the SQL formatter (no space before an opening parenthesis in any construct, JSON arrow spacing, qualified calls and dollar-body handling), the SQL context scanner (identifier and chain detection, call sites) and hover/signature text formatting, the `$N` parameter scanner and PREPARE/EXECUTE template builder (no type detection), the query-shape helpers (`canUseCursor`, `requiresAutocommit`, `parseMaxRows`), CSV escaping, the SQL reference helpers used by completions, tab reordering and session persistence markers, the table-editor diff (change-only ALTER emission and its validations), the row-editor gate and planner (plain-select detection including expression/alias rejections, the parameterized UPDATE builder and its validations), the cell-editor type mapping and temporal/JSON conversions, JSON pretty-printing, the results store's export drain (captured grid, non-retained streaming, consumed-cursor state), the tab-session serializer, storage failure reporting and session round-trips, the connection-number helpers behind `?connect=N` deep links, the AI read-only classifier and wrapper, the AI tool surface over a stubbed bridge (row/byte caps, no-window and multiple-window errors, connection-bound result mirroring that preserves busy/different-connection tabs, the active-result tool's own caps and its limit forwarding, the connection it works on chosen by the window or the single open pool, explicit disconnected-window refusal, and refusal when nothing is connected), the browser bridge reducer (`get`/`set`/`append`/`insert` active query, the active result's rows and messages with the cap trimming applied, tab opening, the `AI` result tab), the MCP shim over a stub HTTP server (tool listing, the staged-for-user instructions it advertises, token forwarding, refused and unreachable pgDEV becoming tool errors), and query cancellation over a Unix-domain socket. |
| `browser/app.mjs` | yes + Chrome | Opt-in (`PGDEV_BROWSER=1`). Drives real Chrome over the DevTools Protocol: connects through the dialog, opens DDL tabs and asserts the editability rules (materialized view read-only, table/view/function editable), double-clicks the empty tab strip to open a query tab, asks the completion provider for suggestions and asserts there are no exact duplicates, that overloads and same-named functions in other schemas are listed separately, that a function sharing a column name stays visible, that built-ins appear once typed (and never unfiltered or `pg_`-prefixed), plus the user function, view, materialized view and stored procedure suggestions and schema-qualified suggestions, asserts hover markdown (commented user function, function-vs-column at a call site, plain column, built-in, schema-qualified overloads), checks that collapse is inert while filtering, that a type-only search matches nothing while a parameter name still matches, confirms a server error reaches the Messages tab, asserts the SQL token colors (`UPDATE` matches the other keywords, string literals are not pure red, function calls are distinct from column and table names), exercises the row editor (edit buttons only on PK-complete results, type-matched controls and locked primary key, a single-line array literal control, a rejected save staying open, a successful save patching the grid and reaching the database), drives the AI bridge as an MCP client (the agent reads and replaces the active tab, stages a `CREATE VIEW` in a new tab that nothing runs, reads the schema of the connection the window has open, finds no tool that runs the editor or lists connections, sees its query mirrored into the `AI` tab, reads the rows and messages the tab produced (including a failed statement's error) and honours a row limit changed in Settings → AI agent, and the bridge comes back after a reload), and that Run is disabled once disconnected. |

## Credentials

The database suites read `PGDEV_TEST_URL` from the environment, or from a
`.env` file at the repository root when the variable is not already set — a real
environment variable always wins. `.env` is gitignored, so no password is
committed; copy the format from the comment in it, or export the variable
directly. It should point at a maintenance database
(`postgres` is fine) whose role may `CREATE DATABASE`.

> **Never aim these at a database you care about.** The suites create and drop
> databases matching `pgdev_%`. Objects inside the target database are never
> modified — it is used only to create and drop the scratch databases.

## Method

Each DDL case is a round-trip rather than a text comparison: create the object,
generate its DDL, **drop the object**, re-execute the generated text verbatim,
then compare catalog fingerprints (`pg_attribute`, `pg_get_constraintdef`,
`pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_range`,
`pg_aggregate`) before and after. That is what catches a script that is
syntactically plausible but does not faithfully reconstruct the object.

The unit suites load the application sources through `test/lib/load.mjs`, which
copies them into a scratch tree with module specifiers retargeted at the `.ts`
files, because the sources use NodeNext `.js` specifiers (server) and
extensionless ones (web) that plain Node cannot resolve.

`p2verify.mjs` is a weaker kind of test: it drives the real request-ordering
logic with stubbed promises, but its other assertions match component source,
so a rewrite that preserves behaviour while changing wording could fail it.
Treat a failure there as a prompt to look, not as proof of a regression.

A few cases cannot be constructed by a test and are therefore not covered:

- An aggregate with `FINALFUNC_EXTRA` needs a final function over `internal`,
  which only a superuser C function may declare. The built-in `array_agg` and
  `percentile_disc` cover that path instead.
- A range type with a `CANONICAL` function needs a pre-created shell type and a
  C function, so it can never be recreated by a standalone script.

## The browser suite

`browser/app.mjs` starts the real server and the Vite dev server against a
scratch database, launches Chrome and drives it through the DevTools Protocol —
no test dependency is added, since Node's global `WebSocket` and `fetch` are
enough. It is opt-in because it needs a Chrome binary (`CHROME_PATH` overrides
the search) and, crucially, **a network path from Chrome to the dev servers**.

It starts the server with AI enabled (`PGDEV_AI=1`), so the page subscribes to the bridge and the suite can drive the agent tools against it. The bridge serves exactly one window, so no other pgDEV tab or window may be open (on any host:port that reaches the same server) while this suite runs, or the AI section fails on purpose. It binds Vite to `127.0.0.1` explicitly: Vite otherwise listens on `[::1]`
only, which Chrome cannot reach, and it uses ports 3010/5173 because the origin
guard permits exactly that cross-port pair (the Vite dev proxy is the one
exception in `allowedOrigin`). Those ports must therefore be free.

Chrome needs `--no-sandbox` here, or its renderer never starts: page-level CDP
commands then hang while browser-level ones still answer, which is a confusing
way to fail. If Chrome has no network at all, every fetch inside the page fails
and the suite reports a blank page; the diagnostic printed on failure includes
the page URL (`chrome-error://chromewebdata/` is the giveaway).

The dev-only hooks the suite relies on (`window.__pgdev` in `QueryEditor.vue`)
are behind `import.meta.env.DEV` and are absent from a production build.
