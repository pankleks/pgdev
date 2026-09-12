# pgDEV

A PostgreSQL IDE that runs on your own machine and opens in your browser.

It is a single local server plus a web UI: you start it, it opens a browser tab,
you point it at a database and work. Nothing is sent anywhere else, and there is
no account to create.

## Install

Needs Node.js 20+ and a PostgreSQL server (11 or newer).

```bash
npm install -g pgdev-ide
pgdev
```

`pgdev` starts the server and opens your browser. Press `Ctrl+C` to stop.

```
--port <n>     listen on this port (default 3000)
--no-open      don't open a browser
--version      print the version
--help         usage
```

If port 3000 is taken it moves to the next free port and prints the URL it used.

**Upgrading:** `npm install -g pgdev-ide@latest`, then restart. Connections,
settings and pinned files live in your browser and are kept.

## Use

1. Start pgDEV and open the URL it prints.
2. Click **Connect** and enter your host, port, database, user and password — or
   paste a connection string. Tick *Remember in this browser* to keep it.
3. Browse objects on the left, or write SQL in the editor and press
   `Ctrl/Cmd+Enter` to run it.

## Features

**Object browser** — tables, views, materialized views, functions, aggregates,
types, indexes, constraints and triggers, with columns and types. Search filters
by object *or* column name (`id col`, `user table`). Double-click an object to
open its DDL.

**DDL preview and editing** — DDL is reconstructed from `pg_catalog`, no
`pg_dump` needed. Functions and views are editable and re-runnable; index,
trigger and type scripts ship with a commented `-- DROP` line. Tables and
constraints are read-only previews, since re-running them would collide with the
existing object.

**Query editor** — Monaco (the editor from VS Code) with completions drawn from
your live schema: tables, views, columns after `alias.`, functions and keywords.
`Ctrl/Cmd+Enter` runs the current selection, or the whole tab if nothing is
selected. `Ctrl/Cmd+Shift+F` formats.

Keyboard: `Ctrl/Cmd+Enter` run · `Ctrl/Cmd+Shift+F` format · `Ctrl/Cmd+N` new
query · `Ctrl/Cmd+O` open file · `Ctrl/Cmd+S` save.

**Results** — a grid per result set, plus a Messages tab with row counts,
timings and errors. Large results stream in 500-row pages (**Load more**), and
CSV export drains every page. Click a column edge to resize; double-click a cell
to copy it; **COPY** copies the loaded rows as TSV.

**Tabs and files** — one tab per query or DDL object. Open and save `.sql` files,
or pin a file to keep it across restarts. Unsaved changes are protected on close.
Right-click a tab to close all, close others, or close everything to the right.

**Connections** — parameter form or connection string, SSL toggle, several saved
connections, switch between them from the badge in the top bar.

## Limits worth knowing

- **Local single user.** There is no login, and the server listens on loopback
  only. Don't expose it to a network.
- **Saved passwords are stored unencrypted** in your browser's IndexedDB if you
  ask it to remember them. Fine for a trusted machine, not for a shared one.
- **30-second statement timeout** per statement, and results are capped at
  10,000 rows per page request.
- **DDL reconstruction is not complete.** Skipped: extended statistics, replica
  identity, foreign-table options, sequence options (start/increment/cache).
  A few aggregate kinds are not reproduced faithfully.
- Cross-origin browser requests to the API are rejected, so a random website
  can't drive your local server.
