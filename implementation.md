# Implementation

## Solution Description

`pgDEV` is a browser-based PostgreSQL IDE with a Fastify backend and a Vue 3 frontend. The browser owns the editor, schema browser, result presentation, and connection form. The backend owns PostgreSQL pools, catalog inspection, DDL reconstruction, query execution, cursor sessions, cancellation, and connection cleanup.

The implementation is designed for local or trusted use. It does not provide user authentication. Database credentials are sent to the backend only when a connection is opened, and optional remembered connections are stored in browser `localStorage`.

The primary design goals are:

- Keep the UI responsive for large result sets.
- Keep PostgreSQL clients and transactions out of the browser.
- Preserve PostgreSQL-specific SQL syntax when splitting or formatting statements.
- Make generated DDL safe for unusual identifiers and common PostgreSQL object types.
- Prevent stale asynchronous responses from replacing current connection or tab state.
- Release database resources when queries, tabs, connections, or sessions end.

## Runtime Architecture

### Backend

- `server/src/index.ts` creates the Fastify application, registers routes, serves the production SPA, and applies the API origin guard.
- `server/src/pools.ts` stores in-memory PostgreSQL pools and tracks running clients by connection and tab.
- `server/src/routes/connections.ts` creates and closes pools.
- `server/src/routes/metadata.ts` exposes schema metadata.
- `server/src/routes/ddl.ts` dispatches DDL requests by object type.
- `server/src/routes/query.ts` executes SQL, returns result sets, pages cursor results, and handles cancellation and session closure.
- `server/src/sessions.ts` owns cursor-backed per-tab sessions and their idle cleanup.
- `server/src/checkout.ts` attaches a per-checkout error handler so a backend-side termination of a checked-out client tears down its session instead of becoming an unhandled process error.
- `server/src/catalog/metadata.ts` queries `pg_catalog` for browser and completion data.
- `server/src/catalog/ddl.ts` reconstructs executable DDL from PostgreSQL catalog data.
- `server/src/sqlsplit.ts` splits a batch into top-level statements without splitting strings, identifiers, comments, or dollar-quoted bodies.
- `server/src/pgcancel.ts` sends PostgreSQL cancel requests using the active connection parameters.

### Frontend

- `web/src/App.vue` provides the application shell, global run action, file opening, resizing, and connection state integration.
- `web/src/components/ConnectDialog.vue` handles parameter-based and connection-string connections.
- `web/src/components/ObjectBrowser.vue` displays searchable tables, views, functions, and types and opens DDL tabs.
- `web/src/components/EditorTabs.vue` manages tab display and closes associated backend sessions.
- `web/src/components/QueryEditor.vue` hosts Monaco models and editor commands.
- `web/src/components/ResultsPanel.vue` displays virtualized results, messages, pagination, copy, export, and cancellation controls.
- `web/src/components/SettingsDialog.vue` exposes the object-browser grouping preference.
- `web/src/composables/connection.ts` manages connection state, remembered configurations, and connection switching.
- `web/src/composables/schema.ts` manages schema loading and stale-request protection.
- `web/src/composables/tabs.ts` stores editor tabs, pinned-file state, and active-tab state.
- `web/src/composables/results.ts` stores per-tab query state and protects asynchronous operations with operation tokens.
- `web/src/composables/settings.ts` persists user preferences.
- `web/src/composables/toast.ts` shows transient status messages.
- `web/src/lib/sqlformat.ts` wraps `sql-formatter` while preserving non-routine dollar-quoted bodies.
- `web/src/lib/gridio.ts` implements clipboard, delimited text, and safe CSV export.
- `web/src/lib/storage.ts` owns IndexedDB persistence for settings, connections, and pinned files, including one-way migration from the earlier `localStorage` keys.
- `web/src/lib/files.ts` wraps the File System Access API with a download fallback.
- `web/src/lib/objectgroups.ts` groups objects by common underscore-separated name prefixes.
- `web/src/lib/tablegroups.ts` adapts that grouping for tables.
- `web/src/lib/formatbridge.ts` connects the toolbar format action to the mounted editor.

## Connection Management

Connections can be opened with either individual parameters or a PostgreSQL connection string.

Parameter-based connections apply these backend settings:

- Pool size: 5 clients.
- Statement timeout: 30 seconds.
- Connection timeout: 10 seconds.
- Application name: `pgDEV`.
- SSL disabled explicitly when the form checkbox is off.
- SSL enabled with `rejectUnauthorized: false` when the form checkbox is on, allowing self-signed certificates.

Connection strings retain their own PostgreSQL SSL parameters instead of being overridden by the form flag.

Pool `error` events are handled so an idle broken client does not become an unhandled process error. Closing a connection first rolls back and releases cursor sessions, then ends the pool.

The frontend supports two local persistence modes:

- With `Remember in this browser`, the configuration is stored in the saved connection list and as the last connection.
- Without it, the current connection is not written to the last-connection key. Existing last-connection data is removed after a successful non-remembered manual connection.

Connection attempts use monotonically increasing attempt identifiers. A stale connection response is disconnected and cannot replace a newer connection. Schema data is reset when switching connections.

## Query Execution

The query endpoint accepts SQL, a tab key, and `maxRows`. Runtime validation requires `maxRows` to be an integer between 1 and 10,000; the default is 500.

The execution flow is:

1. Reject malformed or empty input.
2. Close any idle cursor session for the same connection and tab.
3. Split the SQL batch with the PostgreSQL-aware statement splitter.
4. Detect statements that PostgreSQL requires to run outside a transaction.
5. Use a transaction for ordinary batches, including an initialization savepoint and an idle transaction timeout setting.
6. Execute statements sequentially and preserve command or data results.
7. Resolve result column type names on the same PostgreSQL client.
8. Commit and release the client, or retain one cursor session when more rows are available.

Commands detected for autocommit execution include `VACUUM`, `CLUSTER`, `CHECKPOINT`, database and tablespace operations, `ALTER SYSTEM`, subscription operations, concurrent index operations, concurrent `REINDEX`, and concurrent materialized-view refreshes.

Only the final statement in an all-cursor-compatible batch can retain a cursor. Earlier result sets are fully materialized, so the frontend never displays `Load more` for a cursor that has already been closed. Batches containing writes or other non-cursor statements are completed in the current request and committed instead of leaving mutations in a pageable transaction.

Cursor pages fetch one lookahead row beyond the requested page size. That row is stored as `pendingRow` in the session. This avoids consuming a row that the next request would otherwise skip. A failed `FETCH` is treated as a query failure and is never retried by executing the original SQL a second time.

The running-query map prevents concurrent execution for the same tab. The client identity is checked when clearing that map so an older request cannot clear tracking for a newer request.

## Cursor Sessions and Cleanup

Each retained result cursor is associated with `connectionId` and `tabKey`. Sessions hold:

- The checked-out PostgreSQL client.
- The active cursor name.
- The lookahead row.
- An idle reaper timer.
- A busy flag for active page fetches.
- A close-request flag for tab or connection cleanup races.

Session operations are serialized with `beginSession` and `finishSession`. The idle reaper is paused while a page is being fetched and re-armed only while a cursor remains open. Closing a busy session requests cancellation rather than releasing the client while it is in use.

The following endpoints are available:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/connections/:id/query` | Execute a SQL batch. |
| POST | `/api/connections/:id/query/more` | Fetch the next cursor page. |
| POST | `/api/connections/:id/cancel` | Cancel a running query or page fetch. |
| POST | `/api/connections/:id/query/close` | Roll back and close an idle tab session, or cancel an active operation. |

Sessions are also closed when a tab is closed, a connection is disconnected, a pool client fails, a query completes, a query errors, or the five-minute idle timeout expires.

## Metadata and DDL

Schema metadata is harvested from PostgreSQL system catalogs and grouped into tables, views, functions, and user-defined types. Aggregates are harvested alongside functions (`prokind = 'a'`) and labelled as such in the browser. Table metadata includes columns, indexes, constraints, triggers, partition relationships, and type information for the browser and Monaco completion provider.

DDL generation uses PostgreSQL deparser functions wherever possible, including `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_functiondef`, and `pg_get_viewdef`.

Table DDL additionally handles:

- Always-quoted schema, table, column, constraint, policy, owner, and type identifiers.
- Serial-backed integer columns as `smallserial`, `serial`, or `bigserial` when appropriate.
- `GENERATED ALWAYS AS IDENTITY` columns.
- `GENERATED BY DEFAULT AS IDENTITY` columns.
- Stored generated columns.
- Partition bounds without duplicate `FOR VALUES` clauses; a default partition is emitted as bare `DEFAULT` rather than `FOR VALUES DEFAULT`, and a partition that is itself partitioned keeps its own `PARTITION BY`.
- Foreign keys inherited from a partitioned parent attributed to that parent, so the per-partition duplicate rows collapse into one constraint.
- RLS enablement before RLS force mode.
- Policy role names quoted with PostgreSQL `quote_ident`.
- Foreign tables, tablespaces, comments, indexes, and constraints.
- Quoted attributes for composite types.

Aggregate DDL emits `SFUNC`, `STYPE`, `SSPACE`, `FINALFUNC`, `FINALFUNC_EXTRA`, `FINALFUNC_MODIFY`, `COMBINEFUNC`, `SERIALFUNC`, `DESERIALFUNC`, `INITCOND`, the moving-aggregate options (`MSFUNC`, `MINVFUNC`, `MSTYPE`, `MSSPACE`, `MFINALFUNC`, `MFINALFUNC_EXTRA`, `MFINALFUNC_MODIFY`, `MINITCOND`), `SORTOP` (wrapped as `OPERATOR(...)`), `PARALLEL` and `HYPOTHETICAL`. `FINALFUNC_MODIFY` is written only when it differs from the default for the aggregate kind, and `HYPOTHETICAL` is what keeps a hypothetical-set aggregate from being recreated as an ordered-set one.

Range type DDL emits `SUBTYPE`, `SUBTYPE_OPCLASS`, `COLLATION`, `CANONICAL`, `SUBTYPE_DIFF` and `MULTIRANGE_TYPE_NAME`, omitting `CANONICAL`/`SUBTYPE_DIFF` unless the catalog actually defines them, since a `regproc`/`regclass` cast renders oid 0 as `-` rather than NULL. The multirange name is written only when it differs from the name PostgreSQL would generate. Composite type attributes carry their `COLLATE` clause, and domain constraints keep their constraint names.

Function, view, index, trigger, and type DDL tabs are editable. Table and constraint DDL are presented as read-only previews where direct re-execution could collide with an existing object.

## SQL Parsing and Formatting

The SQL splitter recognizes:

- Single-quoted strings and doubled quote escapes.
- Escape strings and the `standard_conforming_strings` setting.
- Double-quoted identifiers and doubled identifier quotes.
- Nested block comments.
- Line comments.
- Tagged and untagged dollar-quoted bodies.

The formatter scans SQL rather than using a global dollar-body regular expression. Dollar-quoted text inside strings and comments is ignored. Routine bodies after `CREATE FUNCTION`, `CREATE PROCEDURE`, or `DO` may be formatted internally; other dollar-quoted values are preserved byte-for-byte.

Indentation is configured consistently:

- SQL formatter: tab characters with a four-column tab width.
- Monaco: four-column visual tabs, tabs inserted instead of spaces, and automatic indentation detection disabled.

## Frontend State and Race Protection

Schema loads use a version token. Only the latest load may update schema data, errors, or loading state. DDL requests capture the connection ID and discard responses received after a connection switch.

Each tab result has an operation token. Query, page-load, and export operations check that token and the current tab result before updating rows, messages, or loading flags. A new query cannot begin while a page load or export drain is active.

Closing a tab drops its local result state and calls the backend session-close endpoint. Context-menu operations apply the same cleanup to all affected tabs.

The result grid is virtualized and supports column resizing, cell copying, TSV copying, incremental loading, cancellation, and CSV export. CSV cells beginning with spreadsheet formula characters are prefixed with an apostrophe to prevent formula execution when opened by spreadsheet software.

## API Protection

The API has no authentication and can open arbitrary database connections, so `/api/*` requests are protected against drive-by browser requests.

- Requests with an `Origin` header must match the request scheme, hostname, and effective port.
- The Vite development origin on port 5173 is explicitly allowed to proxy to the backend on port 3000 when both hosts are loopback addresses.
- Same-origin browser GET requests that omit `Origin` may use the browser-controlled `Sec-Fetch-Site: same-origin` signal.
- Other requests without `Origin`, invalid origins, cross-origin hosts, schemes, or ports are rejected.

This is not a replacement for authentication or network access control. The application is intended for local or trusted environments.

## Progressive Web App

The frontend uses `vite-plugin-pwa` to generate a web app manifest and a Workbox service worker during the Vite production build. The service worker is registered from `web/src/main.ts` with prompt-based updates so a new build does not reload the IDE without user confirmation and risk losing editor state.

The manifest defines:

- `pgDEV` as the application name and short name.
- `/` as the start URL, scope, and application ID.
- Standalone display mode with the existing dark theme colors.
- Transparent `any` icons at 192x192 and 512x512.
- An opaque dark-navy 512x512 maskable icon for platform-shaped icon containers.

The supplied robot artwork is retained at `web/assets/pwa/robot-source.png`. Generated icon files are stored under `web/public/icons/`:

- `pgdev-192.png`
- `pgdev-512.png`
- `pgdev-maskable-512.png`
- `apple-touch-icon.png`

The Workbox precache includes the application shell and static build assets. The `/api/` runtime route uses `NetworkOnly`, so query results, metadata, connection responses, and cancellation requests are never served from a stale service-worker cache. Offline startup can display the cached IDE shell, but PostgreSQL operations still require the backend and database.

PWA installation works on `localhost` and on HTTPS origins. A non-local HTTP deployment cannot be installed because service workers require a secure context.

## Verification

The main verification command is:

```bash
npm run build
```

This runs `vue-tsc --noEmit`, the Vite production build, and the server TypeScript compiler. Targeted in-memory checks have also covered:

- Cursor lookahead pagination.
- Mutation commit behavior.
- No SQL replay after `FETCH` failure.
- Commit failure propagation.
- Autocommit commands.
- DDL quoting, identity/generated/serial output, RLS ordering, and composite attributes.
- Nested comments, escaped identifiers, dollar quoting, and standard-conforming strings.
- Dollar-body formatter preservation.
- CSV formula protection.
- Same-origin, Vite proxy, missing-origin, and wrong-port behavior.
- PWA manifest generation, icon dimensions, service-worker generation, and API network-only routing.

There is currently no automated test runner in the repository. Live PostgreSQL integration testing requires a local PostgreSQL instance or Docker.

Generated DDL was subsequently round-tripped against a live PostgreSQL 16.14 server: each object is created, its DDL generated, the object dropped, and the generated text re-executed verbatim and compared by catalog fingerprint (`pg_attribute`, `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_range`, `pg_aggregate`). Every object in a 131-table schema (1,538 objects) generated without error. That pass found and fixed the range-type `SUBTYPE_OPCLASS`/`CANONICAL`/`SUBTYPE_DIFF` values, the aggregate `SORTOP`, the duplicate per-partition foreign keys and the `FOR VALUES DEFAULT` bound; a second pass closed the remaining aggregate, range, composite, domain and sub-partitioning gaps.

The HTTP API is also exercised end to end against a live server — connect, `/schema`, `/ddl` for every object type, query execution, cursor paging, errors, cancellation, the 30s statement timeout, autocommit statements, and disconnect — with all fixtures created in a database the test owns and drops afterwards.

Those suites live in `test/` and run with `PGDEV_TEST_URL=postgres://… npm test`; see `test/README.md`. They create and drop their own `pgdev_*` databases and never modify objects in the database they connect to.

## TODO

### PostgreSQL limitations (not fixable here)

- A range type with a `CANONICAL` function can never be recreated by a standalone script: PostgreSQL requires the shell type and the canonical function (which must be written in C) to exist before `CREATE TYPE … AS RANGE (CANONICAL = …)` will run. The generated clause itself is correct.

### Testing

- Add a repository test runner with unit tests for `sqlsplit`, `sqlformat`, `gridio`, sessions, query routing, origin validation, and DDL generation.
- Extend `test/` to cover the object shapes not yet asserted there: tables with list/hash/default partitions, RLS policies, serial columns, and enum types. Aggregate, range, composite, domain and sub-partitioned cases already run.
- Wire `test/` into CI once there is one; today it runs only when invoked by hand with `PGDEV_TEST_URL` set.
- Add end-to-end browser tests for connection switching, tab closure during queries, cancellation, pagination, export, and stale-response scenarios. The HTTP surface is covered against a live server, but nothing exercises Monaco, the object browser, or the result grid.
- Remove or resolve the Vite warning caused by `results.ts` being both statically and dynamically imported.

### Remaining product and deployment work

- Preserve identity and serial sequence options such as start, increment, cache, min/max, and cycle settings.
- Expand DDL coverage for extended statistics, replica identity, FDW options, and inherited table details.
- Add authentication or an explicit deployment-time access-control mechanism for non-local deployments.
- Note that remembered connections are stored unencrypted in the browser's IndexedDB (plain `localStorage` is only read once to migrate legacy data). Replace that with an operating-system or external secret store where deployment requirements justify it.
- Make editor tab width and formatting preferences configurable instead of fixed at four columns.
- Add a repeatable icon-generation script if the robot artwork needs to be updated regularly.
