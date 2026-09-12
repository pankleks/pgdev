# Tests

`npm test` runs every suite. `test/run.mjs` is the entry point: it always runs
the suite that needs no database, and runs the live-database suites only when
`PGDEV_TEST_URL` is set — skipping them with a notice rather than failing when
it is not.

```bash
npm test                                              # source suite only
PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test   # everything
```

`npm test` rebuilds `server/dist` first, because the database suites import the
compiled output rather than the TypeScript sources. Individual suites run the
same way:

```bash
node test/p2verify.mjs
PGDEV_TEST_URL=... node test/apitest.mjs
```

## Suites

| File | Needs a database | Covers |
| --- | --- | --- |
| `p2verify.mjs` | no | Component logic and template guards: the DDL request ordering token (later click wins, superseded and post-switch responses discarded, distinct objects unaffected), materialized views staying read-only, collapse being inert while filtering, and the grid footer reporting loaded rows. |
| `aggtest.mjs` | yes | Aggregate DDL round-trips: plain, `SORTOP`, moving-aggregate, ordered-set, hypothetical-set, `SSPACE`, plus the built-ins `array_agg`, `sum`, `avg` and `max`, which must re-apply from generated text. |
| `typetest.mjs` | yes | Range types (plain, explicit multirange name, explicit collation), composite attribute `COLLATE`, domain constraint names, and sub-partitioned children including their grandchildren. |
| `apitest.mjs` | yes | The documented HTTP surface end to end: connect, `/schema`, `/ddl` for every object type, query execution, multi-statement batches, cursor paging across a 2,500-row result, error and SQLSTATE reporting, the 30s statement timeout, cancellation, `VACUUM` autocommit handling, `maxRows` validation, DDL execution through the query tool, and disconnect. |

## Credentials

The database suites read `PGDEV_TEST_URL` only; nothing is hard-coded and no
password is stored in the repository. It should point at a maintenance database
(`postgres` is fine) whose role may `CREATE DATABASE`.

> **Never aim these at a database you care about.** The suites create and drop
> databases matching `pgdev_%`. Objects inside the target database are never
> modified — it is used only to create and drop the scratch databases.

## Method

Each DDL case is a round-trip rather than a text comparison: create the object,
generate its DDL, **drop the object**, re-execute the generated text verbatim,
then compare catalog fingerprints (`pg_attribute`, `pg_get_constraintdef`,
`pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_range`,
`pg_aggregate`) before and after. That is what catches a script that is
syntactically plausible but does not faithfully reconstruct the object.

`p2verify.mjs` is a weaker kind of test: it drives the real request-ordering
logic with stubbed promises, but its other assertions match component source,
so a rewrite that preserves behaviour while changing wording could fail it.
Treat a failure there as a prompt to look, not as proof of a regression.

A few cases cannot be constructed by a test and are therefore not covered:

- An aggregate with `FINALFUNC_EXTRA` needs a final function over `internal`,
  which only a superuser C function may declare. The built-in `array_agg` and
  `percentile_disc` cover that path instead.
- A range type with a `CANONICAL` function needs a pre-created shell type and a
  C function, so it can never be recreated by a standalone script.

## What is still untested

Nothing here drives a browser, so Monaco, the object browser tree and the
result grid are covered only by reading code. `implementation.md` lists the
browser end-to-end tests in its TODO.

