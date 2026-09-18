# pgDEV

A PostgreSQL IDE that runs on your own machine and opens in your browser.

## Install

Needs Node.js 20+ and a PostgreSQL server (14 or newer).

```bash
npm i @pankleks/pgdev -g
pgdev
```

`pgdev` starts the server and opens your browser. Press `Ctrl+C` to stop.

Use `pgdev --help` to get more info.

**Upgrading:** 

- Stop current instance
- `npm i @pankleks/pgdev@latest -g`

## Use

1. Start pgDEV and open the URL it prints.
2. Click **not connected** to create connection.
3. Double click on db object generates editable DDL script

## AI agents (MCP)

pgDEV exposes MCP server to be used by AI agents. See Settings for more info.

## This is WIP

Use at your own risk.