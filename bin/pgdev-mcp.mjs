#!/usr/bin/env node
// pgDEV MCP shim: exposes the running pgDEV instance to any MCP client
// (opencode, Claude Desktop, …) over stdio. It owns no database access — every
// tool call is forwarded to the pgDEV HTTP API with the bearer token from the
// AI dialog, so pgDEV remains the one place that knows the connections, the
// editor and the results.
//
// Configure a client with (see the AI dialog in pgDEV for a copyable version):
//   PGDEV_URL=http://localhost:3010
//   PGDEV_TOKEN=<from the AI dialog>
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version
const url = (process.env.PGDEV_URL ?? 'http://localhost:3010').replace(/\/+$/, '')
const token = process.env.PGDEV_TOKEN ?? ''

async function callTool(name, args) {
  let res
  try {
    res = await fetch(`${url}/api/ai/tool/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(args ?? {}),
    })
  } catch (err) {
    throw new Error(`Cannot reach pgDEV at ${url} — is it running? (${err.message})`)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 401) {
    throw new Error('pgDEV rejected the token. Copy a fresh MCP config from the AI dialog in pgDEV.')
  }
  if (!res.ok) {
    throw new Error(body?.error ?? `pgDEV request failed (${res.status})`)
  }
  if (body?.ok === false) throw new Error(body.error ?? 'The tool failed.')
  return body?.result
}

const asText = (value) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

const asError = (err) => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
})

/** Wrap a tool body so a failure reaches the agent as an MCP error, not a crash. */
const handler = (name, pick = (args) => args) => async (args) => {
  try {
    return asText(await callTool(name, pick(args ?? {})))
  } catch (err) {
    return asError(err)
  }
}

const server = new McpServer(
  { name: 'pgdev', version },
  {
    instructions:
      'pgDEV is a PostgreSQL IDE that the user has open in a browser; work on the connection it has ' +
      'open (there is no way to list or choose connections, and database tools fail while nothing is ' +
      'connected). `query` only runs read-only statements: SELECT, WITH, VALUES, TABLE, SHOW and ' +
      'EXPLAIN. To create, alter or drop anything, or to change data, author the SQL yourself — start ' +
      'from `get_ddl` when the object already exists — and stage it with `set_active_query` (into the ' +
      'tab the user is looking at) or `open_query_tab` (a new tab). pgDEV never executes staged SQL: ' +
      'the user reviews it and runs it. `get_active_result` shows what the active tab last produced ' +
      '(its result sets and Messages text), so you can check the outcome of a script the user ran. ' +
      'Manage the tabs you opened with `list_tabs` (your tabs are never listed), `activate_tab` and ' +
      '`close_tab`: only clean tabs the agent opened can be closed, and a staged tab stops being ' +
      'closable the moment it is modified.',
  },
)

server.registerTool(
  'get_schema',
  {
    title: 'Read the database schema',
    description:
      'Tables, views, functions and types with their columns, types and comments, from the connection ' +
      'open in pgDEV. Filter with schema/table.',
    inputSchema: {
      schema: z.string().optional().describe('Only objects in this schema'),
      table: z.string().optional().describe('Only this relation name'),
    },
  },
  handler('get_schema'),
)

server.registerTool(
  'get_ddl',
  {
    title: 'Generate object DDL',
    description:
      'Reconstructed CREATE statement for a table, view, function, index, constraint, trigger or type, ' +
      'from the connection open in pgDEV. Also the starting point for an authored change: adjust the ' +
      'script and stage it for the user to run.',
    inputSchema: {
      type: z.enum(['table', 'view', 'function', 'index', 'constraint', 'trigger', 'type']),
      schema: z.string(),
      name: z.string(),
      oid: z.string().optional().describe('Object oid when known (tables/views/functions/types)'),
      parent: z.string().optional().describe('Table name for a constraint or trigger'),
    },
  },
  handler('get_ddl'),
)

server.registerTool(
  'query',
  {
    title: 'Run a read-only query',
    description:
      'Read-only database access: run a single SELECT, WITH, VALUES, TABLE, SHOW or EXPLAIN against the ' +
      'connection open in pgDEV and return the rows. It cannot write or run DDL — author those and stage ' +
      'them with set_active_query or open_query_tab so the user can run them.',
    inputSchema: {
      sql: z.string().describe('The read-only statement to execute'),
    },
  },
  handler('query'),
)

server.registerTool(
  'get_active_query',
  {
    title: 'Read the active tab',
    description: 'The SQL in the pgDEV editor’s active tab, with its read-only flag.',
    inputSchema: {},
  },
  handler('get_active_query'),
)

server.registerTool(
  'get_active_result',
  {
    title: 'Read the active tab result',
    description:
      'What the active tab last produced on screen: every result set with its columns and rows (the ' +
      'agent row limit applies) plus the Messages text, including errors. Read-only — it runs nothing ' +
      'and does not touch the database.',
    inputSchema: {},
  },
  handler('get_active_result'),
)

server.registerTool(
  'set_active_query',
  {
    title: 'Write into the active tab',
    description:
      'Write SQL into the editor tab the user is looking at: replace (default), append, or insert at ' +
      'the cursor. This is how writes and DDL reach the user — nothing is executed, the user reviews ' +
      'the tab and runs it. Refused when that tab is a read-only preview; use open_query_tab instead.',
    inputSchema: {
      sql: z.string().describe('The SQL to write'),
      mode: z
        .enum(['replace', 'append', 'insert'])
        .optional()
        .describe('replace (default) replaces the tab content, append adds it at the end, insert drops it at the cursor'),
    },
  },
  handler('set_active_query'),
)

server.registerTool(
  'open_query_tab',
  {
    title: 'Open a query tab',
    description:
      'Open a new pgDEV query tab pre-filled with SQL: the place to stage a new script (DDL, migration, ' +
      'data change) for the user to review and run. Nothing is executed.',
    inputSchema: {
      sql: z.string().describe('The SQL to put in the new tab'),
      title: z.string().optional().describe('Tab title (defaults to Agent SQL; AI is reserved for the agent log tab)'),
    },
  },
  handler('open_query_tab'),
)

server.registerTool(
  'list_tabs',
  {
    title: 'List the tabs the agent opened',
    description:
      'The tabs the agent opened (with a dirty flag each) and which one the editor shows. ' +
      'Your tabs are never listed.',
    inputSchema: {},
  },
  handler('list_tabs'),
)

server.registerTool(
  'activate_tab',
  {
    title: 'Switch to one of the tabs the agent opened',
    description:
      'Make one of the agent-opened tabs the active tab, by key or by exact title from list_tabs. ' +
      'Tabs the agent did not open cannot be activated.',
    inputSchema: {
      tab: z.string().describe('Tab key, or the exact title from list_tabs'),
    },
  },
  handler('activate_tab'),
)

server.registerTool(
  'close_tab',
  {
    title: 'Close one of the tabs the agent opened',
    description:
      'Close one of the agent-opened tabs, by key or by exact title from list_tabs, with the same ' +
      'cleanup closing it in the UI performs. Refused when the tab has unsaved changes — a freshly ' +
      'staged tab is clean, but the moment it is modified only the user can close it — and for tabs ' +
      'the agent did not open.',
    inputSchema: {
      tab: z.string().describe('Tab key, or the exact title from list_tabs'),
    },
  },
  handler('close_tab'),
)

server.registerResource(
  'active-tab',
  'pgdev://active-tab',
  {
    title: 'pgDEV active tab',
    description: 'The SQL and read-only flag of the active editor tab.',
    mimeType: 'application/json',
  },
  async (uri) => {
    try {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await callTool('get_active_query', {}), null, 2),
          },
        ],
      }
    } catch (err) {
      return {
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: asError(err).content[0].text }],
      }
    }
  },
)

await server.connect(new StdioServerTransport())
