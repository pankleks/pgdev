# pgDEV

A PostgreSQL IDE that runs on your own machine and opens in your browser.

## Install

Needs Node.js 20+ and a PostgreSQL server (14 or newer).

```bash
npm i @pankleks/pgdev -g
pgdev
```

`pgdev` starts the server and opens your browser. Press `Ctrl+C` to stop.

```
--port <n>     listen on this port (default 3010)
--no-open      don't open a browser
--version      print the version
--help         usage
```

**Upgrading:** 

- Stop current instance
- `npm i @pankleks/pgdev@latest -g`

## Use

1. Start pgDEV and open the URL it prints.
2. Click **not connected** to create connection.
3. Double click on db object generates editable DDL script

## AI agents (MCP)

pgDEV always exposes agent access over MCP: the **AI** button in the toolbar
shows the server URL, a token, and a configuration block to paste into your
agent's client (opencode, for example, reads it from `opencode.json`).

The token is generated once and kept in `~/.config/pgdev/token`, so the saved
configuration survives restarts; delete the file to rotate it.

The agent sees the connection you have open in pgDEV and nothing else — it
cannot list, open or choose connections, and its database tools fail with
"not connected" when you are not connected. It reads with `query`, which only
ever runs `SELECT`-style statements, and it can read what the active tab last
produced: the rows in the grid and the Messages text, so it can check what you
ran. Ask it to write a script — a new function, a migration, a data fix — and it
authors the SQL and stages it in a tab for you to review; it can also start from
the current definition it gets via `get_ddl`. Nothing the agent stages is ever
executed: **you** press Run, so the decision is always yours. It keeps track of
the tabs it opened (`list_tabs`, and you are never listed): it can switch to one
and close it again, but not a dirty one — once a staged tab is modified, only you
can close it. How many rows and
bytes of each result set it may read is a preference in Settings → AI agent.
Keep one pgDEV window open — the agent acts on exactly one window and refuses
when several are listening.

## This is WIP

Use at your own risk.