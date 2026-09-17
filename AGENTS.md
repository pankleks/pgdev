# pgDEV — agent instructions

## Git rules (hard requirement)

- **Never commit or push without the user's explicit approval** — this includes
  amending, force-pushing, and creating commits of any kind.
- When work is ready, summarize what changed and ask; commit and push only
  after the user says so.
- `git status` / `git diff` / `git log` inspection is fine at any time.
- never analyze files in `node_modules`, `dist` folder
- analyze `test` folder only in case task calls explicitly for testing
- search web if needed (libs docs, db docs, solutions)

## Project facts

- npm workspaces monorepo: `server/` (Fastify + TypeScript, NodeNext) and
  `web/` (Vue 3 + Monaco + Vite).
- Build gate: `npm run build` (vue-tsc + vite + server tsc).
- Tests: `npm test` (unit + live suites; live suites need `PGDEV_TEST_URL`
  from `.env`, browser suite needs `PGDEV_BROWSER=1` + `CHROME_PATH` and
  ports 3010/5173 free — stop the dev server first).
- Scratch databases are PID-suffixed (`pgdev_*_<pid>`); `.env` is gitignored
  and must never be committed.
- PostgreSQL 14+ is the supported server baseline.
