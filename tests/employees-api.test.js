import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");

const normalizeSql = (sql) => {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
};

const createEmployeesPoolMock = () => {
  const employees = new Map();

  const query = async (sql, params = []) => {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith("insert into employees")) {
      const [name, role, phone, email, status, notes] = params;
      const employee = {
        id: crypto.randomUUID(),
        name,
        role,
        phone: phone ?? null,
        email: email ?? null,
        status,
        notes: notes ?? null,
        created_at: new Date().toISOString()
      };

      employees.set(employee.id, employee);
      return { rowCount: 1, rows: [{ ...employee }] };
    }

    if (normalized.startsWith("update employees set")) {
      const id = params[params.length - 1];
      const employee = employees.get(id);
      if (!employee) {
        return { rowCount: 0, rows: [] };
      }

      const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      if (!setMatch) {
        throw new Error("Unable to parse UPDATE employees query");
      }

      for (const assignment of setMatch[1].split(",")) {
        const field = assignment.split("=")[0]?.trim();
        const placeholder = assignment.match(/\$(\d+)/);
        if (!field || !placeholder) {
          continue;
        }
        const paramIndex = Number(placeholder[1]) - 1;
        employee[field] = params[paramIndex];
      }

      employees.set(id, employee);
      return { rowCount: 1, rows: [{ ...employee }] };
    }

    if (normalized.startsWith("select * from employees order by created_at desc")) {
      return { rowCount: employees.size, rows: [...employees.values()] };
    }

    if (normalized.startsWith("select * from employees where id = $1")) {
      const employee = employees.get(params[0]) ?? null;
      return {
        rowCount: employee ? 1 : 0,
        rows: employee ? [{ ...employee }] : []
      };
    }

    throw new Error(`Unexpected SQL in employees API test: ${sql}`);
  };

  return { query };
};

const requestJson = async (baseUrl, path, { method = "GET", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  return { status: response.status, body: json };
};

test("employees API accepts optional phone/email/notes", async (t) => {
  const originalQuery = pool.query.bind(pool);
  pool.query = createEmployeesPoolMock().query;

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  let employeeId = "";

  await t.test("POST /v2/employees without optional fields returns 201", async () => {
    const { status, body } = await requestJson(baseUrl, "/v2/employees", {
      method: "POST",
      body: {
        name: "Ana",
        role: "Groomer",
        status: "active"
      }
    });

    assert.equal(status, 201);
    assert.equal(body.name, "Ana");
    assert.equal(body.role, "Groomer");
    assert.equal(body.status, "active");
    assert.equal(body.phone, null);
    assert.equal(body.email, null);
    assert.equal(body.notes, null);
    assert.equal(typeof body.id, "string");
    employeeId = body.id;
  });

  await t.test("PUT /v2/employees/:id without optional fields returns 200", async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/employees/${employeeId}`, {
      method: "PUT",
      body: {
        name: "Ana Actualizada",
        role: "Groomer",
        status: "inactive"
      }
    });

    assert.equal(status, 200);
    assert.equal(body.name, "Ana Actualizada");
    assert.equal(body.role, "Groomer");
    assert.equal(body.status, "inactive");
  });

  await t.test('PUT /v2/employees/:id accepts email: "" and treats as null', async () => {
    const { status, body } = await requestJson(baseUrl, `/v2/employees/${employeeId}`, {
      method: "PUT",
      body: {
        email: ""
      }
    });

    assert.equal(status, 200);
    assert.equal(body.email, null);
  });

  await t.test("POST /v2/employees keeps validation error when name is missing", async () => {
    const { status, body } = await requestJson(baseUrl, "/v2/employees", {
      method: "POST",
      body: {
        role: "Groomer",
        status: "active"
      }
    });

    assert.equal(status, 400);
    assert.equal(body.message, "Invalid request body");
  });
});
