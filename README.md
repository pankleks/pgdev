# pgdev — a web IDE for PostgreSQL

Minimal IDE for Postgres in the browser:

- **Object browser** (left): tables, views and functions with columns/types; double-click an object to open its DDL script in a new editor tab (read-only preview, except function/view/index/trigger/type DDL which is editable and runnable — uncomment the leading `-- DROP …` line first where a plain `CREATE` would collide). Search box filters by object or column name.
- **Query tool**: Monaco editor (VS Code) with schema-aware intellisense — tables, views, columns (`alias.` + `Ctrl+Space`), functions and keywords. `Ctrl/Cmd+Enter` runs the query.
- **Results panel**: virtualized data grids (one per result set) plus a Messages tab with row counts, durations and errors. SELECTs show a grid; writes/DDL show affected-row counts.
- **Connection manager**: connect via parameters or connection string; saved connections live in your browser's localStorage. Pools are kept in-memory on the server per session.

## Run (development)

```bash
npm install
docker compose up -d      # optional: demo Postgres on localhost:5433 (user/pass: postgres/pgdev, db: pgdev)
npm run dev               # starts Fastify (port 3000) + Vite (port 5173)
```

Open http://localhost:5173, click **Connect** and point it at any Postgres (demo DB: host `localhost`, port `5433`, db `pgdev`, user `postgres`, password `pgdev`).

## Run (production)

```bash
npm run build   # builds web/dist and server/dist
npm start       # Fastify serves the SPA + API on http://localhost:3000
```

## Project layout

```
server/   Fastify + node-postgres
  src/routes/        connections, metadata, ddl, query endpoints
  src/catalog/       pg_catalog queries: metadata harvesting, DDL reconstruction
web/      Vue 3 + Vite + Monaco
  src/components/    ConnectDialog, ObjectBrowser, EditorTabs, QueryEditor, ResultsPanel
  src/composables/   connection / schema / tabs / results state
  src/monaco/        SQL completion provider fed with live schema metadata
sample/   demo schema (tables, view, functions, indexes)
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/connections` | open a pool, returns `connectionId` |
| DELETE | `/api/connections/:id` | close the pool |
| GET | `/api/connections/:id/schema` | tables/views/functions + columns (drives browser + intellisense) |
| GET | `/api/connections/:id/ddl?type=&schema=&name=` | DDL script for an object |
| POST | `/api/connections/:id/query` | execute SQL, returns result sets or affected-row counts |

## Notes / MVP caveats

- DDL is reconstructed from `pg_catalog` (no `pg_dump` dependency). Tables cover columns, defaults, NOT NULL, PK/unique/FK/check/exclusion constraints, indexes, partitioning (`PARTITION BY` + partition bounds), RLS + policies, owner/comments, tablespaces and foreign servers. Still skipped: extended statistics, replica identity, FDW options. Functions resolve the exact overload from the browser (name-only fallback: first by signature); aggregates are reconstructed, ordered-set ones need a manual check of the `ORDER BY` argument list.
- Results stream in 500-row pages via server-side cursors (`Load more` / CSV export drains all); statement timeout is 30s per statement.
- Saved connections (including password, if you opt in) are stored unencrypted in the browser's localStorage — intended for local/trusted use only. There is no server-side auth, but `/api/*` rejects cross-origin browser requests (same-host `Origin` required) so random websites can't drive your local server.
- Requires PostgreSQL 11+ (tested against 18).
