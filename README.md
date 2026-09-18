# pgDEV

**pgDEV** is a smart IDE for PostgreSQL, built around productivity, simplicity, and a smooth developer experience.

It integrates with the AI coding harness of your choice, bringing AI-assisted development directly into your PostgreSQL workflow.


## 1. Start

>You need Node.js 24+ and a PostgreSQL server (14 or newer).

Install/upgrade with:
```bash
npm i @pankleks/pgdev@latest -g

pgdev
```

`pgdev` starts the server and opens your browser. Press `Ctrl+C` to stop.

On first load you are **not connected** — the sidebar tells you to click the
connection badge in the top bar:

![Not connected](docs/images/manual/01-app-not-connected.png)

## 2. Connect to PostgreSQL

Click the **not connected** badge in the top bar. Fill host, port, database,
user and password — or switch to the **Connection string** tab and paste a
`postgres://user:pass@host:5432/db` URL.

![Connect dialog](docs/images/manual/02-connect-dialog.png)

* **SSL** — enable when your server requires it.
* **Remember in this browser** — saves the connection locally so pgDEV can
  auto-connect next time.
* Saved connections appear on the left of the dialog. Click one to reuse it,
  `X` to forget it, or the power icon to **Disconnect**.

Once connected, the badge shows `user@host:port/database`:

![Connected](docs/images/manual/03-connected-browser.png)

## 3. Tour of the window

* **Top bar** — connection badge, format SQL (wand), PREPARE-template
  builder (sliders), new tab (`Ctrl+N`), open file (`Ctrl+O`), save
  (`Ctrl+S`) / save-as, Settings, version link.
* **Left: Object Browser** — Tables, Views, Types, Functions, Sequences,
  plus a search box and refresh button. Collapse it with the panel icon.
* **Center: query editor** (Monaco) with tabs. Each tab remembers its cursor
  and its connection.
* **Bottom: results panel** — `Result N` grids and a `Messages` tab. Drag the
  dividers to resize; sizes are remembered per browser.

## 4. Navigation tree

Each section header shows an object count. Click a header to expand it;
single-click an object to reveal its children; expanded sections survive a
page reload. The refresh button re-reads the schema from the server.

* **Tables** — expand a table to browse **Columns** (name, type, nullability),
  **Indexes**, **Constraints** (PK / FK / unique / check) and **Triggers**.
* **Views** — expand to see its columns.
* **Functions** — expand to see parameters (name, type) and the return type.
  Overloads are listed separately, e.g. two `item_count` variants.
* **Sequences** — expand for detail: increment, start, type, ownership
  (`owned` vs standalone).
* **Types** — composite and enum types with their detail rows.
* Related objects can be grouped by common name prefix (Settings →
  *Group objects*).
* **Right-click** any node for a context menu: **Collapse** on nodes with
  children, and **Edit…** on editable tables (opens the table editor,
  section 10).
* **Double-click** an object to open its DDL in a new tab (section 6), and
  double-click the empty tab strip to open a fresh query tab.

## 5. Search

The search box filters every section at once. Matching is
case-insensitive and matches are highlighted:

![Search](docs/images/manual/06-search.png)

* `emp` finds tables, the view, function parameters and a sequence —
  note the per-section match counters (`Tables 2/4`, `Sequences 1/3`).
* Separate terms with spaces for OR: `employee labor` matches either.
* Join terms with `+` for AND: `employee+labor` needs both.
* `"quoted phrases"` match exactly.
* A leading/trailing word restricts the search to one kind:
  `table`, `view`, `function` (`func`, `fn`), `column` (`col`),
  `parameter` (`param`), `type`, `sequence` (`seq`).
  Examples: `fn count` lists functions only, `col id` lists columns only,
  `p_emp` finds the function by its parameter name.

## 6. DDL tabs

Double-clicking an object generates its DDL script in a new tab — the full
`CREATE TABLE` with columns, constraints and indexes, ready to edit and run:

![DDL tab](docs/images/manual/07-ddl-tab.png)

* Tables, plain views, sequences and functions open as **editable** scripts:
  tweak and Run to apply.
* Materialized views open **read-only** (DDL preview).
* If you switch connections, a tab bound to another connection refuses to
  run — re-open it against the current database instead.

## 7. Write and run SQL

* `Ctrl+N` opens a query tab; so does double-clicking the empty tab strip.
* You get schema-aware completions (user tables, views, functions, plus
  built-ins once you start typing, never `pg_`-internals), hover
  documentation and function signature help as you type.
* Run with the **Run** button, `F5`, or `Ctrl+Enter`. If text is selected,
  only the selection runs.
* Run is disabled when not connected, when a query is already running, or in
  the read-only AI log tab.

![Run a query](docs/images/manual/04-query-results.png)

A successful run shows a grid with typed column headers (`salary (numeric)`),
`COPY` / `CSV` export buttons, and a `N row(s)` footer. Large results are
paged through a server cursor instead of loading everything at once. Errors
appear in red under **Messages** instead of a grid.

## 8. Row editor

When a result includes the table's primary key, each row gets a pencil
button. (A result without the key, e.g. `SELECT label FROM …`, shows no
edit buttons.) Click it to open the **Edit row** dialog:

![Edit row](docs/images/manual/08-row-editor.png)

* The primary key (`id`) is locked — it identifies the row.
* Each column gets a type-appropriate editor (text areas, numeric inputs,
  date picker) plus a **NULL** checkbox where the column allows it.
* **SAVE** starts disabled and enables on the first change; **CANCEL** closes
  without touching anything.
* Validation happens before any round trip: e.g. invalid JSON is rejected in
  the dialog. A server rejection (e.g. numeric overflow) is shown in the
  dialog too, which stays open so nothing is lost.
* A successful save issues a parameterized `UPDATE … RETURNING` and patches
  the grid cell from the returned row — the value is really in the database.

## 9. Table editor

Right-click a table → **Edit…** (only ordinary and partitioned-parent tables;
partitions inherit their shape, foreign tables speak a different DDL):

![Edit table](docs/images/manual/09-table-editor.png)

* Rename the table, change column types, lengths, precision/scale,
  nullability and defaults, add/drop columns, and edit table/column comments.
* PK / UK / FK badges show existing constraints at a glance.
* **Generate DDL** emits only the changed `ALTER` clauses (drops →
  renames → alters → adds → comments order) for review before applying.
* Guards: no-op edits, locked/PK columns and stale edits (409) are refused
  with an explanation instead of corrupting the table.

## 10. Files and helpers

* Open `.sql` / `.txt` / `.ddl` files via the folder icon or `Ctrl+O`;
  save with `Ctrl+S`, or *save-as* with the second save icon.
* Wand icon or `Ctrl+Shift+F` formats the SQL or just the selection.
* Sliders icon builds a `PREPARE` / `EXECUTE` template from `$N`
  parameters; optionally paste values as a JSON array
  (e.g. `[1, "text", null]`) and Apply.

## 11. Settings and AI agents (MCP)

![Settings](docs/images/manual/05-settings.png)

* **Editor** — font size.
* **Query execution** — statement timeout (applies to new connections).
* **AI agent** — row/size caps for what an MCP agent may read.
* **MCP config / COPY** — copies the JSON snippet for an MCP client
  (opencode, Claude Desktop, …). The agent can then read the schema,
  run read-only queries, and stage writes in a tab **for you to run** —
  it can never press Run itself.
* **Object browser** — group related objects by name prefix.
* **Reset to defaults** restores everything.


