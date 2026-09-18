# pgDEV

**pgDEV** is an IDE for PostgreSQL, built around productivity, simplicity, and a smooth developer experience.

It integrates with the AI coding harness of your choice, bringing AI-assisted development directly into your PostgreSQL workflow.


## 1. Start

>You need Node.js 24+ and a PostgreSQL server (14 or newer).

Install/upgrade with:
```bash
npm i @pankleks/pgdev@latest -g

pgdev
```

`pgdev` serves the API + UI on `http://localhost:3010/` and opens your browser. Press `Ctrl+C` to stop.

![Not connected](docs/images/manual/01-app-not-connected.png)

> Click **Not connected** to setup first connection.

## 2. Connections

Parameters or a `postgres://…` connection string, with optional SSL. Connections persist per browser (auto-connect on load) and support `?connect=N` deep links. The dialog manages the saved set — reuse, forget, or disconnect:

![Connect dialog](docs/images/manual/02-connect-dialog.png)

The badge shows the live connection as `user@host:port/database`.

![Connected](docs/images/manual/03-connected-browser.png)

## 3. Object browser

Section headers carry object counts; expansion survives reload; the refresh button re-reads the schema from the server.

* **Tables** — Columns (name, type, nullability), Indexes, Constraints (PK / FK / unique / check), Triggers.
* **Views** — columns. **Functions** — parameters plus return type, overloads listed separately. **Sequences** — increment, start, type, ownership. **Types** — composite/enum detail rows.
* Prefix grouping for related objects (Settings → *Group objects*).
* Right-click: **Collapse** on parents, **Edit…** on editable tables (section 8). Double-click opens DDL (section 5); double-clicking the empty tab strip opens a fresh query tab.

## 4. Search

One box filters every section; matching is case-insensitive with per-section counters (`Tables 2/4`) and highlighted hits:

![Search](docs/images/manual/06-search.png)

* Spaces are OR (`employee labor`), `+` is AND (`employee+labor`), `"quotes"` are exact.
* A leading/trailing word scopes the kind: `table`, `view`, `function` (`func`, `fn`), `column` (`col`), `parameter` (`param`), `type`, `sequence` (`seq`) — e.g. `fn count`, `col id`. Parameter *names* match (`p_emp` finds its function); argument *types* never do (`integer` matches nothing).
* While filtering, sections force-open and group collapse goes inert; no hits reports `No objects match "…"`.

## 5. DDL tabs

Double-click generates a script built to re-apply verbatim — full `CREATE TABLE` with columns, constraints, indexes and ownership:

![DDL tab](docs/images/manual/07-ddl-tab.png)

Tables, plain views, sequences and functions open **editable**; materialized views open **read-only** as a preview.

## 6. Execution model

`F5` / `Ctrl+Enter` runs the selection if there is one, else the tab. Completions are schema-driven (user objects plus built-ins once typed, never `pg_`-internals), with hover docs and signature help.

![Results](docs/images/manual/04-query-results.png)

* Multi-statement batches run with per-statement result sets; typed column headers, `COPY`/`CSV` export, `N row(s)` footer. Failures land in **Messages**, never as a grid.
* Large results page through a server cursor instead of loading everything.
* Statement timeout (configurable, applies to new connections) plus explicit cancellation bound runaway queries.
* Manual transactions can span runs with transaction-id pinning — a conflicting tab gets a 409 rather than joining the wrong transaction. Statements requiring autocommit (`VACUUM`, …) bypass the transaction path.
* Run stays disabled while disconnected, while a query is in flight, or in the read-only `AI` log tab.

## 7. Row editor

Edit pencils appear only when the result carries the table's primary key (`SELECT label FROM …` has none). The dialog locks the key, offers per-type editors with NULL checkboxes where allowed, and keeps SAVE disabled until the first change:

![Edit row](docs/images/manual/08-row-editor.png)

Invalid input (e.g. malformed JSON) is rejected client-side; server rejections (e.g. numeric overflow) arrive in-dialog with the PostgreSQL message — either way the dialog stays open and nothing is lost. A successful save runs a parameterized `UPDATE … RETURNING` and patches the grid from the returned row.

## 8. Table editor

Right-click → **Edit…** covers ordinary and partitioned-parent tables only (partitions inherit shape; foreign tables speak a different DDL):

![Edit table](docs/images/manual/09-table-editor.png)

Rename, retype (length/precision/scale), nullability, defaults, add/drop columns, table/column comments. **Generate DDL** emits only the changed `ALTER` clauses in apply-safe order (drops → renames → alters → adds → comments) for review. No-ops, locked/PK columns and stale fingerprints (409) are refused with an explanation.

## 9. Helpers

* `Ctrl+Shift+F` formats the selection, or the whole tab when nothing is selected.
* The sliders action builds a `PREPARE` / `EXECUTE` template from `$N` parameters; optional values ride along as a JSON array (e.g. `[1, "text", null]`).
* Tab sessions (open tabs, pinned files) restore across reloads.

## 10. Settings and AI agent (MCP)

![Settings](docs/images/manual/05-settings.png)

Settings are per-browser: editor font size, statement timeout for new connections, object grouping by name prefix, and the AI row/size caps. **Reset to defaults** restores everything.

### MCP access

pgDEV exposes an MCP server.

Read tools: `query`, `get_schema` (optional `schema`/`table` filters; relation lists truncate past 200 entries), `get_ddl` (`type`/`schema`/`name`, plus `oid`/`parent` to pin overloads and constraints), `get_active_result` (the active tab's grids capped like `query`, plus the last 100 Messages lines — so the agent sees the outcome, including errors, of scripts *you* ran; no database access happens here). Editor tools: `get_active_query`, `set_active_query` (`replace`/`append`/`insert`), `open_query_tab`, `list_tabs`, `activate_tab`, `close_tab`.