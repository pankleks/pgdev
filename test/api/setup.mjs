// Shared harness for the live API suites in test/api/: a scratch database
// seeded with the common fixture, the real Fastify app, and teardown.
//
// Each suite owns its database (`pgdev_api_<label>_<pid>`) so the suites stay
// independent and can be run singly: `PGDEV_TEST_URL=... node test/api/ai.mjs`.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { credentials, Client } from '../lib/db.mjs'
import { createApp } from '../../server/dist/app.js'

export { Client, createApp }

export const FIXTURE = `
CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  location text
);
CREATE TABLE employees (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id integer NOT NULL REFERENCES departments(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text UNIQUE,
  salary numeric(10,2),
  total numeric(12,2) GENERATED ALWAYS AS (salary * 2) STORED,
  hired_at date DEFAULT current_date
);
CREATE INDEX idx_emp_dept ON employees(department_id);
CREATE UNIQUE INDEX idx_emp_email ON employees(lower(email));
CREATE VIEW v_emp AS SELECT e.id, e.first_name, d.name AS department
  FROM employees e JOIN departments d ON d.id = e.department_id;
CREATE MATERIALIZED VIEW mv_dept AS SELECT department_id, count(*) AS n FROM employees GROUP BY department_id;
CREATE SEQUENCE seq_apitest INCREMENT 10 MINVALUE 5 MAXVALUE 500 START 100;
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE DOMAIN positive_int AS integer NOT NULL DEFAULT 1 CHECK (VALUE > 0);
CREATE TYPE floatrange AS RANGE (subtype = float8);
CREATE AGGREGATE sum_sq(integer) (SFUNC = int4pl, STYPE = integer, INITCOND = '0', PARALLEL = SAFE);
CREATE FUNCTION dept_count(p_name text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.name = p_name
$$;
COMMENT ON FUNCTION dept_count(text) IS 'Counts employees in a department.';
CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.first_name := initcap(NEW.first_name); RETURN NEW; END $$;
CREATE TRIGGER trg_emp BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION trg_fn();
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE TABLE big (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text);
INSERT INTO big (label) SELECT 'row' || g FROM generate_series(1, 2500) g;
INSERT INTO departments (name, location) VALUES ('Engineering','Berlin'),('Sales','London'),('HR','Remote');
INSERT INTO employees (department_id, first_name, last_name, email, salary) VALUES
  (1,'ada','Lovelace','ada@example.com',8500.00),
  (1,'alan','Turing','alan@example.com',9000.00),
  (2,'grace','Hopper','grace@example.com',8200.00);
ANALYZE;
`

export const ORIGIN = 'http://localhost'

/**
 * Boot one suite: credentials, scratch database with the fixture, and the
 * real application (the origin guard and route wiring under test are the
 * ones that ship). The agent token file points at scratch space: no suite
 * may read or write the user's real one.
 */
export async function boot(label) {
  const base = await credentials()
  // The PID suffix lets two runs (or two CI jobs) share one server without
  // DROP ... WITH (FORCE) destroying each other's database.
  const DB = `pgdev_api_${label}_${process.pid}`

  // Registered before anything can throw, so a crash cannot strand the
  // scratch database (node exits on unhandled rejections without running
  // late handlers).
  process.on('uncaughtException', async (e) => {
    console.log('unexpected error:', e.message)
    try {
      const adm = new Client({ ...base, database: 'postgres' })
      await adm.connect()
      await adm.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
      await adm.end()
    } catch { /* best effort */ }
    process.exit(2)
  })

  const admin = new Client({ ...base, database: 'postgres' })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${DB}`)
  await admin.end()
  const setup = new Client({ ...base, database: DB })
  await setup.connect()
  await setup.query(FIXTURE)
  await setup.end()

  const aiTokenFile = join(tmpdir(), `pgdev_aitoken_${label}_${process.pid}`)
  const app = await createApp({ serveStatic: false, aiTokenFile })

  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { origin: ORIGIN } })
    let body = null
    try { body = res.json() } catch { body = res.body }
    return { status: res.statusCode, body }
  }

  const cleanup = async () => {
    await app.close().catch(() => {})
    rmSync(aiTokenFile, { force: true })
    const adm = new Client({ ...base, database: 'postgres' })
    await adm.connect()
    await adm.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
    const left = await adm.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_%'`)
    await adm.end()
    return left.rows.map((r) => r.datname)
  }

  return { base, DB, app, ORIGIN, aiTokenFile, call, cleanup }
}
