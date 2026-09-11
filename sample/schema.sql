CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  location text
);

CREATE TABLE employees (
  id serial PRIMARY KEY,
  department_id integer NOT NULL REFERENCES departments(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text UNIQUE,
  salary numeric(10, 2),
  hired_at date DEFAULT current_date
);

CREATE TABLE projects (
  id serial PRIMARY KEY,
  name text NOT NULL,
  budget numeric(12, 2)
);

CREATE TABLE employee_projects (
  employee_id integer NOT NULL REFERENCES employees(id),
  project_id integer NOT NULL REFERENCES projects(id),
  role text,
  PRIMARY KEY (employee_id, project_id)
);

CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_last_name ON employees(last_name);

CREATE VIEW v_employee_details AS
SELECT e.id, e.first_name, e.last_name, e.email, e.salary, d.name AS department
FROM employees e
JOIN departments d ON d.id = e.department_id;

CREATE FUNCTION dept_employee_count(p_dept text) RETURNS integer AS $$
  SELECT count(*)::int
  FROM employees e
  JOIN departments d ON d.id = e.department_id
  WHERE d.name = p_dept
$$ LANGUAGE sql STABLE;

CREATE FUNCTION raise_salary(p_emp integer, p_pct numeric) RETURNS numeric AS $$
DECLARE
  new_sal numeric;
BEGIN
  UPDATE employees
  SET salary = salary * (1 + p_pct / 100)
  WHERE id = p_emp
  RETURNING salary INTO new_sal;
  RETURN new_sal;
END;
$$ LANGUAGE plpgsql;

INSERT INTO departments (name, location) VALUES
  ('Engineering', 'Berlin'),
  ('Sales', 'London'),
  ('HR', 'Remote');

INSERT INTO employees (department_id, first_name, last_name, email, salary) VALUES
  (1, 'Ada', 'Lovelace', 'ada@example.com', 8500.00),
  (1, 'Alan', 'Turing', 'alan@example.com', 9000.00),
  (2, 'Grace', 'Hopper', 'grace@example.com', 8200.00),
  (3, 'Edsger', 'Dijkstra', 'edsger@example.com', 7800.00);

INSERT INTO projects (name, budget) VALUES
  ('Apollo', 120000.00),
  ('Zeus', 80000.00);

INSERT INTO employee_projects (employee_id, project_id, role) VALUES
  (1, 1, 'lead'),
  (2, 1, 'dev'),
  (2, 2, 'advisor'),
  (3, 2, 'lead');
