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

- `server/src/index.ts` starts the application: it calls `createApp()` and listens on a port.
- `server/src/app.ts` builds the Fastify application, registers routes, serves the production SPA, and applies the API origin guard.
- `server/src/version.ts` reads the version from the root manifest for `/api/version`.
- `bin/pgdev.mjs` is the launcher: picks a free port, starts the server, opens the browser, and shuts down on Ctrl+C.
- `server/src/pools.ts` stores in-memory PostgreSQL pools (a main pool plus a small catalog pool per connection) and tracks running clients by connection and tab.
- `server/src/routes/connections.ts` creates and closes both pools and cancels in-flight queries when a connection is closed.
- `server/src/routes/metadata.ts` exposes schema metadata.
- `server/src/routes/ddl.ts` dispatches DDL requests by object type.
- `server/src/routes/query.ts` is the HTTP adapter for query execution: it validates input, maps outcomes to status codes, and serializes errors.
- `server/src/queryexec.ts` owns batch execution, cursor sessions, cancellation, and the checked-out-client lifecycle.
- `server/src/boundedquery.ts` executes a statement once and drains it, retaining only the display cap in memory.
- `server/src/queryshape.ts` classifies statements for routing: cursor compatibility, autocommit requirements, transaction control, and `maxRows` validation.
- `server/src/sessions.ts` owns cursor-backed per-tab sessions and their idle cleanup.
- `server/src/checkout.ts` attaches a per-checkout error handler so a backend-side termination of a checked-out client tears down its session instead of becoming an unhandled process error.
- `server/src/catalog/metadata.ts` queries `pg_catalog` for browser and completion data.
- `server/src/catalog/ddl.ts` reconstructs executable DDL from PostgreSQL catalog data.
- `server/src/catalog/tableedit.ts` reads the table-editor state and diffs a submitted edit into change-only ALTER statements.
- `server/src/catalog/rowedit.ts` resolves a plain SELECT's table to its row-editing identity (columns, generated flags, primary key) and decides whether a result's columns identify rows uniquely.
- `server/src/selectshape.ts` detects a plain single-table SELECT (no joins, set operations, grouping or expression select lists) and extracts its table and selected columns.
- `server/src/rowupdate.ts` is the pure planner for the row editor: it validates a submitted key/change set against a live catalog read and builds the single parameterized `UPDATE … RETURNING *`.
- `server/src/routes/rowupdate.ts` maps a row save to one UPDATE, joining the tab's open transaction session when there is one.
- `server/src/pgtypes.ts` selects the identity type parsers that keep JSON/JSONB and temporal values as raw server text.
- `server/src/sqlident.ts` quotes PostgreSQL identifiers for SQL text generation.
- `server/src/sqlsplit.ts` splits a batch into top-level statements without splitting strings, identifiers, comments, or dollar-quoted bodies.
- `server/src/pgerror.ts` normalizes PostgreSQL and network errors into a non-empty message.
- `server/src/pgcancel.ts` sends PostgreSQL cancel requests over TCP (optionally TLS) or a Unix-domain socket using the active connection parameters.
- `server/src/ai/readonly.ts` classifies an agent statement as a plain read and wraps the batch so PostgreSQL runs it in a read-only transaction.
- `server/src/ai/bridge.ts` is the server half of the browser bridge: request/response over the SSE stream, with `no-window`, timeout, and disconnect errors.
- `server/src/ai/tools.ts` implements the agent tools (schema, DDL, read-only query, editor actions) with row and byte caps, on the connection pgDEV has open.
- `server/src/routes/ai.ts` serves `/api/ai/*`: token-guarded tool calls, the browser configuration payload, the live agent result limits, and the browser SSE stream.
- `bin/pgdev-mcp.mjs` is the stdio MCP shim: it publishes those tools to an MCP client and forwards calls with the bearer token.

### Frontend

- `web/src/App.vue` provides the application shell, global run action, file opening, resizing, and connection state integration.
- `web/src/components/ConnectDialog.vue` handles parameter-based and connection-string connections.
- `web/src/components/ObjectBrowser.vue` displays searchable tables, views, functions, and types and opens DDL tabs; its search matches names only (objects, columns, parameter names), never column or argument types.
- `web/src/components/TableEditDialog.vue` edits a table's description and columns and submits the result for diffing into a new query tab.
- `web/src/components/RowEditDialog.vue` edits one result row: a type-matched field per column with NULL checkboxes, PK/generated fields locked, one UPDATE on SAVE.
- `web/src/components/EditorTabs.vue` manages tab display, closes associated backend sessions, and reorders tabs by drag and drop; double-clicking the empty tab strip opens a new query tab.
- `web/src/components/QueryEditor.vue` hosts Monaco models and editor commands.
- `web/src/components/ResultsPanel.vue` displays virtualized results, messages, pagination, copy, export, cancellation controls, the transaction indicator with Commit/Rollback buttons, and the per-row edit button for editable results.
- `web/src/components/SettingsDialog.vue` exposes the object-browser grouping preference.
- `web/src/composables/connection.ts` manages connection state, remembered configurations, and connection switching.
- `web/src/composables/schema.ts` manages schema loading and stale-request protection.
- `web/src/composables/tabs.ts` stores editor tabs, pinned-file state, active-tab state, and the tab session machinery.
- `web/src/composables/results.ts` stores per-tab query state and protects asynchronous operations with operation tokens.
- `web/src/composables/settings.ts` persists user preferences, including how much of a result set an AI agent may read.
- `web/src/composables/toast.ts` shows transient status messages.
- `web/src/lib/sqlformat.ts` wraps `sql-formatter` while preserving non-routine dollar-quoted bodies.
- `web/src/lib/gridio.ts` implements clipboard, delimited text, and safe CSV export.
- `web/src/lib/cellvalue.ts` formats result cells for the value dialog (token-preserving JSON pretty-printing).
- `web/src/lib/celleditor.ts` maps column types to row-editor controls and converts temporal values between PostgreSQL text and native control values.
- `web/src/lib/storage.ts` owns IndexedDB persistence for settings, connections, pinned files, and the tab session, including one-way migration from the earlier `localStorage` keys.
- `web/src/lib/connectionref.ts` parses the `?connect=N` deep link and assigns stable connection numbers (pure helpers).
- `web/src/lib/tabsession.ts` serializes and restores the user-tab session (pure helpers).
- `web/src/lib/files.ts` wraps the File System Access API with a download fallback.
- `web/src/lib/objectgroups.ts` groups objects by common underscore-separated name prefixes.
- `web/src/lib/tablegroups.ts` adapts that grouping for tables.
- `web/src/lib/formatbridge.ts` connects the toolbar format action to the mounted editor.
- `web/src/lib/preparemap.ts` scans `$N` parameters and builds the PREPARE/EXECUTE template (no type detection — PostgreSQL infers parameter types from the query).
- `web/src/lib/aibridge.ts` is the pure reducer for AI bridge actions: read or write the active tab, open tabs, run a tab, mirror agent rows.
- `web/src/composables/ai.ts` subscribes to the AI bridge stream, dispatches those actions through the tab, result, and connection stores, and pushes the agent's result limits to the server.
- `web/src/components/AiDialog.vue` reports the AI access state and shows the ready-to-paste MCP client configuration.

## Connection Management

Connections can be opened with either individual parameters or a PostgreSQL connection string.

Parameter-based connections apply these backend settings:

- Main pool size: 5 clients.
- Catalog pool size: 4 clients, in a second pool that serves `/schema` and `/ddl`; paged cursor sessions pin main-pool clients, so catalog queries must not share that budget.
- Statement timeout: from the browser's settings (seconds, 1–600, default 30; sent as `statementTimeout` with the connect request and applied at pool level).
- Connection timeout: 10 seconds.
- Application name: `pgDEV`.
- SSL disabled explicitly when the form checkbox is off.
- SSL enabled with `rejectUnauthorized: false` when the form checkbox is on, allowing self-signed certificates.

Connection strings retain their own PostgreSQL SSL parameters instead of being overridden by the form flag.

Pool `error` events are handled so an idle broken client does not become an unhandled process error. Closing a connection first cancels request-owned queries, then rolls back and releases cursor sessions, then ends both pools.

The frontend supports two local persistence modes:

- With `Remember in this browser`, the configuration is stored in the saved connection list and as the last connection.
- Without it, the current connection is not written to the last-connection key. Existing last-connection data is removed after a successful non-remembered manual connection.

Every remembered connection carries a stable number (`1`, `2`, …) shown in the connection list. A number is assigned when the configuration is first remembered, survives re-saving, and is never reused: the connections record keeps a high-water mark, so forgetting a connection does not hand its number to a later one. On startup `?connect=N` connects to the numbered saved connection for that session; it does not replace the last connection used by a normal launch, and an unknown number is reported and falls back to the usual last-connection auto-connect.

Connection attempts use monotonically increasing attempt identifiers. A stale connection response is disconnected and cannot replace a newer connection. Schema data is reset when switching connections.

## Query Execution

The query endpoint accepts SQL, a tab key, and `maxRows`. Runtime validation requires `maxRows` to be an integer between 1 and 10,000; the default is 500.

The execution flow is:

1. Reject malformed or empty input.
2. Continue a user-opened transaction session for the tab, if one exists.
3. Close any idle cursor session for the same connection and tab.
4. Split the SQL batch with the PostgreSQL-aware statement splitter.
5. Detect statements that PostgreSQL requires to run outside a transaction.
6. Use a transaction for ordinary batches, including an initialization savepoint and an idle transaction timeout setting.
7. Execute statements sequentially and preserve command or data results.
8. Resolve result column type names on the same PostgreSQL client, and for plain single-table SELECTs resolve row-editing metadata (primary key, real columns, generated flags) through the same client.
9. Commit and release the client, retain one cursor session when more rows are available, or pin the client as a transaction session when the batch leaves a user transaction open.

Commands detected for autocommit execution include `VACUUM`, `CLUSTER`, `CHECKPOINT`, database and tablespace operations, `ALTER SYSTEM`, subscription operations, concurrent index operations, concurrent `REINDEX`, and concurrent materialized-view refreshes.

Only the final statement in an all-cursor-compatible batch can retain a cursor. Earlier result sets are fully materialized, so the frontend never displays `Load more` for a cursor that has already been closed. Batches containing writes or other non-cursor statements are completed in the current request and committed instead of leaving mutations in a pageable transaction.

Manual transactions span query runs. A batch that opens a transaction without closing it (`BEGIN; …`) runs directly on a fresh client — no implicit wrapper — and the client is kept pinned as a **transaction session**, so the user's transaction is never committed behind their back. Subsequent batches on the same tab run on that client; `COMMIT`/`ROLLBACK` end the session, `COMMIT AND CHAIN` keeps a new transaction open, and a failed statement leaves PostgreSQL's aborted transaction open for `ROLLBACK`. An error in the batch that opened the transaction rolls it back immediately instead. Cursor paging is disabled inside a manual transaction (the session keeps the transaction, not a cursor), so large results are bounded like non-cursor statements. Each query response carries `transactionOpen`, which the results panel turns into a TXN indicator with Commit/Rollback buttons; the transaction is bounded by the same five-minute idle reaper as cursor sessions, and closing the tab or disconnecting rolls it back.

Cursor pages fetch one lookahead row beyond the requested page size. That row is stored as `pendingRow` in the session. This avoids consuming a row that the next request would otherwise skip. A failed `FETCH` is treated as a query failure and is never retried by executing the original SQL a second time.

The running-query map prevents concurrent execution for the same tab. The client identity is checked when clearing that map so an older request cannot clear tracking for a newer request.

## Cursor and Transaction Sessions

Each retained session is associated with `connectionId` and `tabKey` and holds:

- The checked-out PostgreSQL client.
- The session kind: `cursor` (open transaction with a server-side cursor) or `transaction` (a user-opened transaction with no cursor).
- The active cursor name and the lookahead row (cursor sessions).
- An idle reaper timer.
- A busy flag for active page fetches.
- A close-request flag for tab or connection cleanup races.

Session operations are serialized with `beginSession` and `finishSession`. The idle reaper is paused while a page is being fetched and re-armed while a cursor or user transaction remains open. Closing a busy session requests cancellation rather than releasing the client while it is in use. A session released after the user's own `COMMIT`/`ROLLBACK` hands the client back without issuing another control statement.

The following endpoints are available:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/connections/:id/query` | Execute a SQL batch. |
| POST | `/api/connections/:id/query/more` | Fetch the next cursor page. |
| POST | `/api/connections/:id/cancel` | Cancel a running query or page fetch. |
| POST | `/api/connections/:id/query/close` | Roll back and close an idle tab session, or cancel an active operation. |
| GET | `/api/connections/:id/tableedit/:oid` | Table-editor state for one table. |
| POST | `/api/connections/:id/tableedit/:oid` | Diff a submitted table edit into a change-only ALTER script. |
| POST | `/api/connections/:id/row-update` | Store one edited result row with a single UPDATE. |

Sessions are also closed when a tab is closed, a connection is disconnected, a pool client fails, a query completes, a query errors, or the five-minute idle timeout expires.

## Metadata and DDL

Schema metadata is harvested from PostgreSQL system catalogs and grouped into tables, views, functions, and user-defined types. Aggregates are harvested alongside functions (`prokind = 'a'`) and labelled as such in the browser. Table metadata includes columns, indexes, constraints, triggers, partition relationships, and type information for the browser and Monaco completion provider. Functions additionally carry `arguments` (`pg_get_function_arguments`: parameter names, modes and defaults, used for hover/completion while DDL keeps the identity arguments) and `comment` (`obj_description` on `pg_proc`). Built-in `pg_catalog` functions are harvested separately (`builtins`): internal `pg_`-prefixed helpers and functions with internal argument or result types are filtered out, and the list feeds completion and hover only — the object browser never shows it. Built-ins carry their catalog comments too, so hovering `jsonb_build_object` explains it. The grammar-level callables that are not `pg_proc` entries (`coalesce`, `nullif`, `greatest`, `least`) are added to the same list by hand, so they complete and hover like the catalog functions.

The completion provider suggests keywords and every harvested object: tables, views (including materialized), types, functions, and stored procedures — each with its signature line (`(args) → result`, `(args) · procedure`, plus `· aggregate`/`· window` markers) and a `name($0)` snippet, schema-qualified unless the object lives in `public`. Function suggestions are keyed by name, insert text and signature, so overloads and same-named functions in other schemas are listed as separate rows, and a function sharing a column's name is not hidden by the column; non-public signatures name their schema in the detail line. Every function row shows its parameter list inline and every column row its `type · relation`, so identical labels stay distinguishable; when the word is followed by `(` (a call site) functions sort above same-named columns. Built-in functions (for example `json_build_object`, `generate_series`, `array_agg`) follow the same `name($0)` shape but are only offered once the typed word is at least two characters and matches their prefix, which keeps both the list and the provider cheap. Relation aliases and qualifiers offer their columns; after a schema qualifier (`app.`) the provider lists that schema's tables, views, types, functions and procedures, since a schema has no columns of its own.

A hover provider resolves the identifier under the cursor against the loaded schema using the same pure scanner (`sqlcontext.ts`) that completion uses for call-site detection. At a call site the function or procedure wins over a same-named column; elsewhere a matching column wins and a function still hovers when no column matches. Function hovers list the overloads (up to five, then a remainder line) with their signature, kind, schema and catalog comment; column hovers show type, owning relation, nullability and default. Comment text is markdown-escaped, and the hover range is the identifier itself.

DDL generation uses PostgreSQL deparser functions wherever possible, including `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_functiondef`, and `pg_get_viewdef`.

Table DDL additionally handles:

- Objects resolved by OID but named from the catalog, so a stale request name cannot target a different object.
- Always-quoted schema, table, column, constraint, policy, owner, and type identifiers.
- Foreign keys via `pg_get_constraintdef`, preserving `MATCH`, `NOT VALID`, deferred and `ON DELETE`/`ON UPDATE SET NULL|DEFAULT (columns)` clauses. A foreign key that references a partition of a partitioned table is rewritten to name the partitioned parent; identical per-partition copies are de-duplicated (ordinary same-shaped foreign keys are not).
- `NOT VALID` constraints emitted with `ALTER TABLE … ADD CONSTRAINT` after the table, because `CREATE TABLE` silently ignores that clause and would recreate them as validated.
- Serial-backed integer columns as `smallserial`, `serial`, or `bigserial` when appropriate.
- `GENERATED ALWAYS AS IDENTITY` and `GENERATED BY DEFAULT AS IDENTITY` columns, and stored generated columns.
- Column `COLLATE` clauses, which `format_type` does not carry.
- Partition bounds without duplicate `FOR VALUES` clauses; a default partition is emitted as bare `DEFAULT` rather than `FOR VALUES DEFAULT`, and a partition that is itself partitioned keeps its own `PARTITION BY`.
- Plain inheritance via `INHERITS`, listing only the child's local columns, so inherited columns, constraints and defaults come from the parent.
- Primary-key `INCLUDE` columns are not treated as key columns, so their `NOT NULL` is not suppressed.
- RLS enablement before RLS force mode, and policy role names quoted with PostgreSQL `quote_ident` (`PUBLIC` preserved).
- Foreign tables with their table- and column-level FDW options, tablespaces, comments, indexes, and constraints.
- Quoted attributes for composite types.

Aggregate DDL emits `SFUNC`, `STYPE`, `SSPACE`, `FINALFUNC`, `FINALFUNC_EXTRA`, `FINALFUNC_MODIFY`, `COMBINEFUNC`, `SERIALFUNC`, `DESERIALFUNC`, `INITCOND`, the moving-aggregate options (`MSFUNC`, `MINVFUNC`, `MSTYPE`, `MSSPACE`, `MFINALFUNC`, `MFINALFUNC_EXTRA`, `MFINALFUNC_MODIFY`, `MINITCOND`), `SORTOP` (wrapped as `OPERATOR(...)`), `PARALLEL` and `HYPOTHETICAL`. Every function and operator reference is schema-qualified so the script does not depend on `search_path`. `FINALFUNC_MODIFY` is written only when it differs from the default for the aggregate kind, `INITCOND`/`MINITCOND` are quoted with `quote_literal` (an empty-string initial condition stays distinct from NULL), and `HYPOTHETICAL` is what keeps a hypothetical-set aggregate from being recreated as an ordered-set one.

Range type DDL emits `SUBTYPE`, `SUBTYPE_OPCLASS`, `COLLATION`, `CANONICAL`, `SUBTYPE_DIFF` and `MULTIRANGE_TYPE_NAME`, omitting `CANONICAL`/`SUBTYPE_DIFF` unless the catalog actually defines them, since a `regproc`/`regclass` cast renders oid 0 as `-` rather than NULL. The multirange name is written only when it differs from the name PostgreSQL would generate, and it is schema-qualified. Composite type attributes carry their `COLLATE` clause, domains carry theirs, and domain constraints keep their constraint names.

View DDL carries the view's `reloptions` (`WITH (...)`), owner and comment; materialized-view DDL additionally carries its indexes and tablespace. A view is recreated with `CREATE OR REPLACE`; because PostgreSQL has no `CREATE OR REPLACE MATERIALIZED VIEW`, a materialized view is only ever a read-only preview.

Every DDL tab is editable. Functions and views re-run via `CREATE OR REPLACE`; table, constraint, index, trigger, and type scripts ship with a commented drop line, so rebuilding means uncommenting it — an explicit, destructive choice (the table drop is plain `IF EXISTS`, so dependent objects fail loudly rather than cascade silently). The only read-only preview is a materialized view: PostgreSQL has no `CREATE OR REPLACE MATERIALIZED VIEW`, so its script cannot run over the existing object.

## Table Editor

Right-clicking an ordinary table (`relkind = 'r'`) or a partitioned parent (`'p'`) in the object browser offers **Edit…**, which opens a dialog showing the table name read-only, an editable table description, and the column list. Columns are editable in place (name, type, nullable, default, description); the primary-key flag is read-only, and identity, generated, and serial columns are locked except for their description (serial columns keep nullability editable, since it is independent of the sequence machinery). Columns can be added and deleted; deleting a primary-key column is refused in the dialog and by the server. Foreign keys and unique keys are indicated read-only with running badges (`FK1`, `FK2`, … and `UK1`, `UK2`, …, numbered per constraint or index in catalog order — every column of one key shares its number), and hovering a badge shows the key's name and `pg_get_constraintdef`/`pg_get_indexdef` definition; a column in two keys shows both badges. Unique-key badges cover constraint-backed keys and standalone unique indexes alike (an index's `INCLUDE` columns are not badged).

The dialog never executes anything. **OK** submits the desired column set to `POST …/tableedit/:oid`, which re-reads the live catalog (`catalog/tableedit.ts`), validates the request against it — unknown columns, duplicate final names, empty names/types, edits to locked attributes, and nullable flips on primary-key columns are rejected with 400 — and runs the pure `diffTableEdit` function. Non-editable relations (views, materialized views, indexes, sequences, foreign tables, and partitions, which take their shape from the parent) are rejected up front with 400. The read response also carries a fingerprint of the live state; the submit must echo it, and a mismatch is refused with 409 rather than diffed against a stale column set — without it, a column added after the dialog loaded would be read as a deletion and dropped. Existing columns are identified by catalog attnum (never by name, which is editable), and added rows carry an explicit flag, so a column literally named `new:1` is never re-added. The result is a change-only script emitted in dependency-safe order: drops (before renames, so a rename may reuse a dropped name), renames ordered so every target name is free when used (chains are reversed and swaps/cycles unroll through a collision-free temporary name), per-column `ALTER COLUMN … TYPE|SET|DROP NOT NULL|SET|DROP DEFAULT` clauses using post-rename names, `ADD COLUMN` clauses with `DEFAULT` before `NOT NULL`, then `COMMENT ON COLUMN`/`COMMENT ON TABLE` statements (a dropped column's comment is never emitted, and clearing a comment emits `IS NULL`). Before comparing, defaults and types are normalised with a literal-aware scanner (whitespace outside strings, identifiers, dollar bodies and comments is collapsed; contents are compared byte-for-byte), while the emitted clauses keep the user's exact text. `null` is returned when nothing differs. Quoting follows the same `ident()` conventions as DDL generation.

The generated script opens in a fresh, clean query tab bound to the connection it was generated against, so the existing stale-connection run guard applies and the user executes it explicitly. Table edits are out of scope for partitions and foreign tables.

## Row Editor

A result grid whose rows have an unambiguous table identity gets a narrow leading column with a pencil button per row. The gate is deliberately strict (`server/src/selectshape.ts` and `catalog/rowedit.ts`): the statement must be a **plain single-table SELECT** — no joins, set operations, CTEs, `DISTINCT`, `GROUP BY`/`HAVING`/`WINDOW`, subqueries or functions in `FROM`, `SELECT INTO`, or locking clauses — and the table must be an ordinary or partitioned table (`relkind` `r`/`p`) whose **full primary key appears in the result, unaliased and exactly once**. The select list must be `*`, `qualifier.*` or plain (possibly qualified) column references: an expression aliased to a real column name (`id + 1 AS id`) could produce a key value that no longer identifies the row it came from, so any other item disables editing for the whole result. Duplicate column names and generated columns are never editable, and `bytea` is refused because its cell transport is a `<bytea N bytes>` summary. The metadata travels with the data result (`DataResult.editable`) and is advisory only — the save endpoint re-reads the catalog on every call.

Clicking the pencil opens a dialog listing one row per result column in a three-column table — column name/type (with any read-only tag), the value control, and the NULL checkbox. Columns whose names start with `_` (system-ish companions) are shown after the ordinary ones, matching the table editor's display convention. Each value control matches its type: boolean gets a value checkbox, numeric types a `type="number"` input (`step=1` for the integer family, `any` otherwise), `date`/`time without time zone`/`timestamp [with|without] time zone` native `date`/`time`/`datetime-local` inputs, JSON/JSONB a textarea holding the token-safe pretty reprint, `text` a textarea, and every other type — `varchar(n)`, `char`, uuid, enums and the rest — a single-line text input. Integer and text/varchar arrays — and boolean arrays (`{TRUE,FALSE}`) — are edited the same way, as PostgreSQL literals (`{10, 20}`): the driver leaves them unparsed, the grid shows the literal, and the edited text is sent back as one parameter. Values with more than one dimension (`{{1,2},{3,4}}`) are shown locked, because a single-line literal cannot represent dimensions faithfully. Declared character lengths (`varchar(n)`/`char(n)`) travel with the result metadata and set a matching `maxlength` on the control; PostgreSQL still enforces the real limit. Every nullable editable field has a NULL checkbox that disables its value control; NOT NULL columns (the primary key among them) get an empty NULL cell, so they cannot be erased through the dialog. The primary key is shown but locked, and generated, expression/duplicate and binary columns are shown read-only with a tag. SAVE is disabled until something actually differs from the row as loaded, identifies each field by its original value, and sends only the changed columns, so an untouched field — including a `timestamptz` whose native control cannot carry an offset — is never written back.

SAVE issues exactly one parameterized `UPDATE "schema"."table" SET … WHERE pk = … RETURNING *` through `POST …/row-update`. Changed JSON/JSONB text is syntax-checked in the browser first (`JSON.parse` in a try/catch) and the save is refused with the field's name when it does not parse — the check only validates; the token-preserving textarea text is what gets sent, so number spellings and large integers are never rewritten. The server then re-derives the table identity from the catalog, requires the key to be exactly the primary key, rejects primary-key, generated, binary and unknown columns, and quotes all identifiers itself (`sqlident.ts`); only values are parameters. A key matching no row returns 404 ("Row not found — it may have been deleted; re-run the query."). Conflicts are last-write-wins by design. When the tab has an open manual transaction, the UPDATE runs on that session's client, so `ROLLBACK` undoes it, `COMMIT` persists it, and a failed statement leaves the usual aborted transaction for the user to end; without a transaction it is one autocommit statement. The returned row patches the loaded grid cells by column name, so trigger effects, casts and generated values appear immediately without re-running the query.

Temporal values, JSON/JSONB and boolean/integer/text/varchar arrays arrive as raw PostgreSQL text (not ISO strings or JSON-looking JS arrays): the per-query type parsers keep `date`, `time`, `timestamp`, `timestamptz`, `timetz`, their arrays, `json`/`jsonb` and the boolean, integer and text/varchar array types unparsed, so the grid, CSV export and the editor all see the exact server text. A `timestamp with time zone` is edited as the browser's wall clock; the offset is dropped on save and PostgreSQL interprets the value in the session timezone, which is the same instant on a single machine.

## SQL Parsing and Formatting

The SQL splitter recognizes:

- Single-quoted strings and doubled quote escapes.
- Escape strings and the `standard_conforming_strings` setting.
- Double-quoted identifiers and doubled identifier quotes.
- Nested block comments.
- Line comments.
- Tagged and untagged dollar-quoted bodies.

The formatter scans SQL rather than using a global dollar-body regular expression. Dollar-quoted text inside strings and comments is ignored. Routine bodies after `CREATE FUNCTION`, `CREATE PROCEDURE`, or `DO` may be formatted internally; other dollar-quoted values are preserved byte-for-byte.

Function calls stay tight to their parenthesis. `sql-formatter` only treats names in its fixed PostgreSQL function list as calls, so the wrapper collects the names the query actually calls — scanning past strings, comments and quoted identifiers — and adds them to the dialect's function list for call-style layout. A masked pass then removes every space before an opening parenthesis in code, whatever precedes it: `IN(1, 2)`, `VALUES(1)`, `EXISTS(SELECT …)`, `ANY($6)`, `sch.fn(x)`, `t(a, b)` and `KEY(a)` all come out tight. Only spaces and tabs are dropped — a parenthesis that starts a line keeps its indentation — and text inside strings, comments and non-routine dollar-quoted literals is never rewritten. PostgreSQL JSON arrows (`->`, `->>`, `#>`, `#>>`) are tightened the same way, so `dr.field_bag ->> 'level'` becomes `dr.field_bag->>'level'` — including negative index operands such as `data -> -1`.

Indentation is configured consistently:

- SQL formatter: tab characters with a four-column tab width.
- Monaco: four-column visual tabs, tabs inserted instead of spaces, and automatic indentation detection disabled.

The editor uses a derived Monaco theme (`pgdev-dark`, defined in `web/src/monaco.ts`) instead of raw `vs-dark`: the bundled SQL grammar files `UPDATE` — and other SQL Server spellings such as `COUNT` or `GETDATE` — under its built-in functions, which `vs-dark` paints magenta, and it paints every string literal pure red. The theme maps those two tokens to the keyword blue and the familiar muted string colour, leaving the rest of the palette untouched. The bundled SQL grammar is also extended with one rule: a word directly followed by `(` is a function call (bright amber `#FFC66D`, clearly apart from the white identifiers, blue keywords and salmon strings) unless it is an operator or one of the clause keywords that legitimately precede a parenthesis (`IN (`, `VALUES (`, `OVER (`, `FILTER (`, `NOT (`, …). Because the grammar's keyword list contains many PostgreSQL function names (`TRANSLATION`, `LEFT`, `REPLACE`, …), those calls would otherwise be painted as keywords; the curated clause list keeps the real clauses keyword-coloured while every other keyword-named call gets the function colour. The grammar object is mutated before the lazy language loader registers it, so the extension survives registration.

## Parameter Templates

The toolbar's sliders button opens a values bar and turns the query (or the selection) into an editable `PREPARE`/`EXECUTE` template. `web/src/lib/preparemap.ts` scans the statement for top-level `$N` parameters — skipping string literals, comments, dollar-quoted bodies and identifiers that merely contain a `$` (`a$1` is a name) — and builds:

```sql
PREPARE temp AS
	SELECT * FROM product WHERE id = $1 AND _active = $2;


EXECUTE temp(
	NULL, -- $1
	NULL -- $2
);


DEALLOCATE temp;
```

Values pasted into the bar as a JSON array (optionally behind a `--` prefix, as such lines often arrive from logs) replace the placeholders positionally and are converted to SQL literals (`ARRAY[…]` for arrays, JSON text for objects); every parameter without a value stays `NULL`, and gaps (`$1`, `$3`) are filled in too. **No parameter types are detected or declared**: PostgreSQL infers them from the query context, so the template emits `PREPARE temp AS` with no type list, which works on the supported PostgreSQL versions. A `;` is appended when the statement lacks one, and never inside a trailing line comment.

## Frontend State and Race Protection

Schema loads use a version token. Only the latest load may update schema data, errors, or loading state. DDL requests capture the connection ID and discard responses received after a connection switch.

Each tab result has an operation token. Query, page-load, and export operations check that token and the current tab result before updating rows, messages, or loading flags. A new query cannot begin while a page load or export drain is active.

Closing a tab drops its local result state and calls the backend session-close endpoint. Context-menu operations apply the same cleanup to all affected tabs.

The tab session saves user-created query tabs — and only those: DDL tabs, generated SQL from the table editor, file tabs, and pinned files are never part of it. A signature over the persistable tabs (keys, titles, contents, and the active tab) is compared every `SESSION_SAVE_INTERVAL_MS` (10 seconds, a constant in `composables/tabs.ts`) and again on `pagehide`; the write is skipped while nothing changed, and a rejected write is retried on the next tick. The session is global — connection state plays no part, so switching connections or disconnecting never swaps, closes, or rebinds tabs. At startup `sessionsReady` restores the saved tabs (fresh unsaved query tabs with their order, titles, contents, and active selection) before the default tab is created. Storage is a `tabs` IndexedDB store, with a `pgdev.tabs` localStorage fallback; unreadable data simply means nothing to restore.

The result grid is virtualized and supports column resizing, cell copying, TSV copying, incremental loading, cancellation, and CSV export. CSV cells beginning with spreadsheet formula characters are prefixed with an apostrophe to prevent formula execution when opened by spreadsheet software.

CSV export captures the grid before any await, so a selection change while the save picker or the drain is open cannot switch the target; the drain re-validates that capture (result identity and operation token) on every page and aborts a stale export. With the File System Access picker, pages stream straight to disk with every write awaited — a failed write aborts the file, and drained pages are **not** retained in the grid, so memory stays flat for large results. Because that consumes the backend cursor, the grid then keeps its first page, stops advertising pagination, and records the exported total (`exported`), which the footer reports; without the picker the fallback drains into the grid and downloads a Blob. Pinned-file persistence distinguishes "saved without file handles" (false) from total failure: when IndexedDB and the localStorage fallback both reject the write, the save rejects so the UI can warn instead of silently losing the pins.

NULL and boolean cells render as badges (a dark steel-blue `null` chip; green `true` and gray `false`) so sentinel values cannot be mistaken for stored strings; exports still write the empty string for NULL. Double-clicking a `json`/`jsonb` cell opens a value dialog that pretty-prints the JSON with a two-space indent and offers a COPY button (which closes the dialog); every other cell type copies its value straight to the clipboard, and NULL stays inert. JSON/JSONB and temporal columns travel as raw server text — per-query type parsers keep the driver from `JSON.parse`-ing JSON or turning dates into JS `Date`s — so large integers, number spellings (`1.0`), JSON string scalars and wall-clock timestamps survive; the dialog formats JSON with a token-preserving scanner (`web/src/lib/cellvalue.ts`) that copies every token verbatim and falls back to the raw text when the JSON does not parse. Editable results additionally show a per-row pencil that opens the row editor (see above).

## API Protection

The API has no authentication and can open arbitrary database connections, so `/api/*` requests are protected against drive-by browser requests.

- Requests with an `Origin` header must match the request scheme, hostname, and effective port. The three loopback spellings (`localhost`, `127.0.0.1`, `::1`) are treated as the same host, because browsers and the launcher choose between them inconsistently; both sides must still be loopback.
- The Vite development origin on port 5173 is explicitly allowed to proxy to the backend on port 3010 when both hosts are loopback addresses.
- Same-origin browser GET requests that omit `Origin` may use the browser-controlled `Sec-Fetch-Site: same-origin` signal.
- Other requests without `Origin`, invalid origins, cross-origin hosts, schemes, or ports are rejected.

This is not a replacement for authentication or network access control. The application is intended for local or trusted environments.

## AI Access (MCP)

pgDEV can hand its database context to an external AI agent, so the agent can read schema and data and stage SQL in the editor without being given a database connection of its own.

The surface is off by default and enabled with `pgdev --ai` (or `PGDEV_AI=1`). The server then mints one random token per run (`createAiToken()`); the launcher points at the **AI** dialog in the toolbar, which shows the server URL, the token, and a ready-to-paste MCP client configuration from `GET /api/ai/config`. `bin/pgdev-mcp.mjs` is a stdio MCP server built on the official `@modelcontextprotocol/sdk` that an MCP client starts; it publishes the tools and forwards each call to `POST /api/ai/tool/:name` with the token, which the server compares with `timingSafeEqual`. Tool calls are the one place where the drive-by-origin rule does not apply — an agent is not a browser and sends no `Origin` — so the token is the only credential, the endpoints do not exist at all unless AI is enabled, and the token dies with the process.

The agent tools are:

- `get_schema`, `get_ddl` — the catalog reads the object browser already uses; `get_ddl` also gives the agent the current definition to start a change from. A schema read is capped at 200 relations.
- `query` — the only tool that executes anything, and it only reads: the statement is classified first (`server/src/ai/readonly.ts` accepts `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW` and `EXPLAIN`, and rejects locking clauses) and then runs inside a read-only transaction, so PostgreSQL is the real guarantee and the classifier only exists to give a clearer message. Writes and DDL never reach the database through it — the agent is told to author them instead.
- `get_active_query`, `set_active_query` (`replace`, `append` or `insert`), `open_query_tab` — the editor, and the path writes and DDL take. The agent reads the active tab and stages the SQL it authored — a new function, an `ALTER`, a data fix — in that tab or in a new one; nothing executes it, so the user reviews it in pgDEV and presses Run. `set_active_query` refuses a read-only preview tab (a materialized view's generated DDL, say) and points at `open_query_tab`.
- `get_active_result` — what the active tab last produced on screen: every result set with its columns and rows, plus the Messages text (errors included) and the tab's flags (`ran`, `running`, `transactionOpen`, `selected`). Read-only UI state; it touches no database.
- The MCP resource `pgdev://active-tab` serves the same active-tab view.

How much of a result set the agent may read is a preference: Settings → **AI agent** sets the row limit (default 100) and the byte budget (default 64 KB) per result set, the browser pushes them to `PUT /api/ai/limits` on load and on every change, and the tool layer reads the live values, so a change applies to the next tool call. Rows are capped, but the total and the truncation are reported.

The stdio shim advertises that contract where the agent actually reads it: the MCP server `instructions` and every tool description say that reads go through `query`, that writes and DDL are authored and staged for the user to run, and that staged SQL is never executed by pgDEV. The contract is a framing one — nothing in the server blocks DDL from being *written*, only from being executed.

The agent works on the connection pgDEV has open and cannot see or pick another one: there is no tool or resource that lists connections, `connection` is not an argument, and the database tools resolve the target as the connection named by the listening window — or, with no window, the single pool the server holds. With nothing connected they fail with "pgDEV is not connected to a database"; with several pools and no window to say which one is in use, they fail and say so too.

Each statement's rows are capped at 100 rows and 64 KB (`DEFAULT_AI_LIMITS` in `server/src/ai/tools.ts`), with the cap reported rather than silent. The first result of a `query` is also mirrored into a dedicated `AI` tab — the agent's SQL and its rows — so the user can see what the agent read; there is deliberately no chat UI in pgDEV, because prompts and answers belong to the agent's own client.

The editor tools need a page to act on. They travel to the browser over the SSE stream at `GET /api/ai/bridge` (`server/src/ai/bridge.ts` holds the pending request/response pairs) and come back via `POST /api/ai/bridge/result`; with no window subscribed, or when the window does not answer within 15 seconds, the tool fails with that reason instead of hanging. Exactly one window may be subscribed: an action is delivered only while a single page is listening, and the rows of a `query` are mirrored there for the same reason. With several windows subscribed the editor tools refuse (broadcasting would run every action in each window and let the first answer win), and the message tells the user to close the extra ones.

## Distribution

The package ships a launcher, `bin/pgdev.mjs`, exposed as the `pgdev` command.
It picks a free port (walking upward from 3010 if the requested one is taken),
starts the server, waits until `/api/version` answers, opens the default
browser, and forwards SIGINT/SIGTERM to the server for a clean shutdown. It
takes `--port`, `--no-open`, `--version` and `--help`.

The server serves its own frontend, so there is nothing to deploy separately:
the built SPA and the API share one origin, which is what the API origin guard
requires. The intended deployment is a single machine — the launcher binds
loopback only.

`web/public/icons/` holds the favicon and the Apple touch icon referenced by
`web/index.html`. There is no web app manifest and no service worker: the
browser loads the build fresh each time, so an upgrade is a server restart
followed by a page refresh.

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
- The AI read-only classifier, the tool surface over a stubbed bridge, the browser bridge reducer, and the MCP shim over a stub server (tool listing, token forwarding, error surfacing).

There is an automated test runner: `npm test` builds the server, runs the `node:test` unit suites and the source-level checks, then runs the live-database suites when `PGDEV_TEST_URL` is set (and the browser suite when `PGDEV_BROWSER=1`). Live PostgreSQL integration testing otherwise requires a local PostgreSQL instance or Docker.

Generated DDL was subsequently round-tripped against a live PostgreSQL 16.14 server: each object is created, its DDL generated, the object dropped, and the generated text re-executed verbatim and compared by catalog fingerprint (`pg_attribute`, `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_range`, `pg_aggregate`). Every object in a 131-table schema (1,538 objects) generated without error. That pass found and fixed the range-type `SUBTYPE_OPCLASS`/`CANONICAL`/`SUBTYPE_DIFF` values, the aggregate `SORTOP`, the duplicate per-partition foreign keys and the `FOR VALUES DEFAULT` bound; a second pass closed the remaining aggregate, range, composite, domain and sub-partitioning gaps. The live suites now also round-trip foreign-key `MATCH`/`NOT VALID`/`SET NULL (columns)`, `NOT VALID` deferral, column and domain `COLLATE`, primary-key `INCLUDE`, `INHERITS`, view/materialized-view attributes, foreign-table FDW options and empty-string `INITCOND`.

The HTTP API is also exercised end to end against a live server — connect, `/schema`, `/ddl` for every object type, query execution, cursor paging, errors, cancellation, the 30s statement timeout, autocommit statements, and disconnect — with all fixtures created in a database the test owns and drops afterwards.

With AI enabled, the same run covers the agent surface: a tool call without or with the wrong token is rejected, a read-only `query` returns its rows on the open connection without a browser window, a write is refused by the classifier, a data-modifying CTE — which classifies as a read — is refused by the read-only transaction, filtered schema and DDL reads, the explicit no-window error, a fresh server with nothing connected reporting that it is not connected, and the limits endpoint validating its range and applying a changed row limit to the next `query`. The browser suite then repeats it against a live page: the agent reads and replaces the active tab, stages a `CREATE VIEW` in a new tab that nothing runs, reads the schema of the connection the window has open, finds no tool that runs the editor or lists connections, sees its query result in the `AI` tab, reads the rows and messages of what the user ran (including a failed statement's error), and honours a row limit changed in Settings.

Those suites live in `test/` and run with `PGDEV_TEST_URL=postgres://… npm test`; see `test/README.md`. They create and drop their own `pgdev_*` databases and never modify objects in the database they connect to.

## TODO

### PostgreSQL limitations (not fixable here)

- A range type with a `CANONICAL` function can never be recreated by a standalone script: PostgreSQL requires the shell type and the canonical function (which must be written in C) to exist before `CREATE TYPE … AS RANGE (CANONICAL = …)` will run. The generated clause itself is correct.

### Testing

- Extend the unit suites to `sqlformat` and to the session/tab state machines, which the current `node:test` files do not cover.
- Extend `test/` to cover the object shapes not yet asserted there: serial columns, exclusion constraints, and materialized-view tablespaces. Partitions (list/hash/default), RLS policies, enum/composite/domain/range types, foreign-table options and sub-partitioned cases already run.
- Wire `test/` into CI once there is one; today it runs only when invoked by hand with `PGDEV_TEST_URL` set.
- Extend the browser suite (`test/browser/app.mjs`, opt-in via `PGDEV_BROWSER=1`) to connection switching, tab closure during queries, cancellation, pagination, export, the result grid, and stale-response scenarios. It currently covers connecting, the DDL tab read-only rules, completion duplicates, and inert collapse while filtering.
- Remove or resolve the Vite warning caused by `results.ts` being both statically and dynamically imported.

### Remaining product and deployment work

- Preserve identity and serial sequence options such as start, increment, cache, min/max, and cycle settings.
- Expand DDL coverage for extended statistics, replica identity, table access methods, and column storage/compression settings.
- Add authentication or an explicit deployment-time access-control mechanism for non-local deployments.
- Note that remembered connections are stored unencrypted in the browser's IndexedDB (plain `localStorage` is only read once to migrate legacy data). Replace that with an operating-system or external secret store where deployment requirements justify it.
- Make editor tab width and formatting preferences configurable instead of fixed at four columns.
