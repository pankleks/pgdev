# Live database tests

These suites exercise the DDL generator and the HTTP API against a real
PostgreSQL server. They are not unit tests: each one creates its own scratch
databases named `pgdev_*`, runs its cases, and drops them again.

## Running

```bash
PGDEV_TEST_URL=postgres://user:pass@host:5432/postgres npm test
```

`npm test` rebuilds `server/dist` first, because the suites import the compiled
output rather than the TypeScript sources. Running an individual suite works the
same way:

```bash
PGDEV_TEST_URL=... node test/apitest.mjs
```

Credentials are read from `PGDEV_TEST_URL` only; nothing is hard-coded and no
password is stored in the repository. `PGDEV_TEST_URL` should point at a
maintenance database (`postgres` is fine) whose role may `CREATE DATABASE`.

> **Never aim these at a database you care about.** The suites create and drop
> databases matching `pgdev_%`. Objects inside the target database are never
> modified — the target is only used to create and drop the scratch databases.

## Suites

| File | Covers |
| --- | --- |
| `aggtest.mjs` | Aggregate DDL round-trips: plain, `SORTOP`, moving-aggregate, ordered-set, hypothetical-set, `SSPACE`, plus the built-ins `array_agg`, `sum`, `avg` and `max`, which must re-apply from generated text. |
| `typetest.mjs` | Range types (plain, explicit multirange name, explicit collation), composite attribute `COLLATE`, domain constraint names, and sub-partitioned children including their grandchildren. |
| `apitest.mjs` | The documented HTTP surface end to end: connect, `/schema`, `/ddl` for every object type, query execution, multi-statement batches, cursor paging across a 2,500-row result, error and SQLSTATE reporting, the 30s statement timeout, cancellation, `VACUUM` autocommit handling, `maxRows` validation, DDL execution through the query tool, and disconnect. |

## Method

Each DDL case is a round-trip rather than a text comparison: create the object,
generate its DDL, **drop the object**, re-execute the generated text verbatim,
then compare catalog fingerprints (`pg_attribute`, `pg_get_constraintdef`,
`pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef`, `pg_range`,
`pg_aggregate`) before and after. That is what catches a script that is
syntactically plausible but does not faithfully reconstruct the object.

A few cases cannot be constructed by a test and are therefore not covered:

- An aggregate with `FINALFUNC_EXTRA` needs a final function over `internal`,
  which only a superuser C function may declare. The built-in `array_agg` and
  `percentile_disc` cover that path instead.
- A range type with a `CANONICAL` function needs a pre-created shell type and a
  C function, so it can never be recreated by a standalone script.

## Relationship to the rest of the tests

`README.md` describes the production build check (`npm run build`). These suites
are the integration layer; there is still no unit-test runner for the pure
modules (`sqlsplit`, `sqlformat`, `gridio`, `sqlrefs`) and no browser test that
drives Monaco, the object browser, or the result grid. Both are listed in the
TODO in `implementation.md`.
