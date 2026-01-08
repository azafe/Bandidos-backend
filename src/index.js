import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool } from "./db.js";

const app = express();

const corsOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const statusSchema = z.enum(["active", "inactive"]);

const createUserSchema = z.object({
  email: z.string().email(),
  password_hash: z.string().min(1),
  role: z.string().min(1)
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  password_hash: z.string().min(1).optional(),
  role: z.string().min(1).optional()
});

const createEmployeeSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  phone: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  status: statusSchema,
  notes: z.string().min(1).optional().nullable()
});

const updateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  phone: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  status: statusSchema.optional(),
  notes: z.string().min(1).optional().nullable()
});

const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const createPetSchema = z.object({
  customer_id: z.string().uuid(),
  name: z.string().min(1),
  breed: z.string().min(1).optional().nullable(),
  size: z.string().min(1).optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const updatePetSchema = z.object({
  customer_id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  breed: z.string().min(1).optional().nullable(),
  size: z.string().min(1).optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const createServiceTypeSchema = z.object({
  name: z.string().min(1),
  default_price: z.coerce.number().min(0).optional().nullable()
});

const updateServiceTypeSchema = z.object({
  name: z.string().min(1).optional(),
  default_price: z.coerce.number().min(0).optional().nullable()
});

const createPaymentMethodSchema = z.object({
  name: z.string().min(1)
});

const updatePaymentMethodSchema = z.object({
  name: z.string().min(1).optional()
});

const createServiceRecordSchema = z.object({
  date: z.string().min(1),
  pet_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  service_type_id: z.string().uuid(),
  price: z.coerce.number().min(0),
  payment_method_id: z.string().uuid(),
  groomer_id: z.string().uuid().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const updateServiceRecordSchema = z.object({
  date: z.string().min(1).optional(),
  pet_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  service_type_id: z.string().uuid().optional(),
  price: z.coerce.number().min(0).optional(),
  payment_method_id: z.string().uuid().optional(),
  groomer_id: z.string().uuid().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const createSupplierSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1).optional().nullable(),
  phone: z.string().min(1).optional().nullable(),
  payment_method_id: z.string().uuid().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const updateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional().nullable(),
  phone: z.string().min(1).optional().nullable(),
  payment_method_id: z.string().uuid().optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const createExpenseCategorySchema = z.object({
  name: z.string().min(1)
});

const updateExpenseCategorySchema = z.object({
  name: z.string().min(1).optional()
});

const createDailyExpenseSchema = z.object({
  date: z.string().min(1),
  category_id: z.string().uuid(),
  description: z.string().min(1),
  amount: z.coerce.number().min(0),
  payment_method_id: z.string().uuid(),
  supplier_id: z.string().uuid().optional().nullable()
});

const updateDailyExpenseSchema = z.object({
  date: z.string().min(1).optional(),
  category_id: z.string().uuid().optional(),
  description: z.string().min(1).optional(),
  amount: z.coerce.number().min(0).optional(),
  payment_method_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional().nullable()
});

const createFixedExpenseSchema = z.object({
  name: z.string().min(1),
  category_id: z.string().uuid(),
  amount: z.coerce.number().min(0),
  due_day: z.coerce.number().int().min(1).max(31),
  payment_method_id: z.string().uuid(),
  supplier_id: z.string().uuid().optional().nullable(),
  status: statusSchema
});

const updateFixedExpenseSchema = z.object({
  name: z.string().min(1).optional(),
  category_id: z.string().uuid().optional(),
  amount: z.coerce.number().min(0).optional(),
  due_day: z.coerce.number().int().min(1).max(31).optional(),
  payment_method_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional().nullable(),
  status: statusSchema.optional()
});

const sendError = (res, status, message) => {
  return res.status(status).json({ status, message });
};

const buildUpdate = (allowedFields, payload) => {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const field of allowedFields) {
    if (payload[field] !== undefined) {
      fields.push(`${field} = $${idx}`);
      values.push(payload[field]);
      idx += 1;
    }
  }

  return { fields, values, idx };
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/services", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM services ORDER BY date DESC, created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/services", async (req, res) => {
  const parsed = createServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const {
    date,
    pet_id,
    customer_id,
    service_type_id,
    price,
    payment_method_id,
    groomer_id,
    notes
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO services
        (date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        date,
        pet_id,
        customer_id,
        service_type_id,
        price,
        payment_method_id,
        groomer_id ?? null,
        notes ?? null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/services/:id", async (req, res) => {
  const parsed = updateServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    [
      "date",
      "pet_id",
      "customer_id",
      "service_type_id",
      "price",
      "payment_method_id",
      "groomer_id",
      "notes"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE services SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/services/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM services WHERE id = $1", [
      req.params.id
    ]);

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/users", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/users/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "User not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { email, password_hash, role } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [email, password_hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/users/:id", async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["email", "password_hash", "role"],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE users SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "User not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/users/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "User not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/employees", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM employees ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/employees/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM employees WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Employee not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/employees", async (req, res) => {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name, role, phone, email, status, notes } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO employees (name, role, phone, email, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, role, phone ?? null, email ?? null, status, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/employees/:id", async (req, res) => {
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["name", "role", "phone", "email", "status", "notes"],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE employees SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Employee not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/employees/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM employees WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Employee not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/customers", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const hasQuery = query.length > 0;
  const sql = hasQuery
    ? `SELECT * FROM customers
       WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1
       ORDER BY created_at DESC`
    : "SELECT * FROM customers ORDER BY created_at DESC";
  const params = hasQuery ? [`%${query}%`] : [];

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/customers/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM customers WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Customer not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/customers", async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name, phone, email, notes } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO customers (name, phone, email, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, phone ?? null, email ?? null, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/customers/:id", async (req, res) => {
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["name", "phone", "email", "notes"],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE customers SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Customer not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/customers/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM customers WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Customer not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/pets", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const customerId = typeof req.query.customer_id === "string" ? req.query.customer_id.trim() : "";
  const filters = [];
  const params = [];

  if (customerId) {
    params.push(customerId);
    filters.push(`customer_id = $${params.length}`);
  }

  if (query) {
    params.push(`%${query}%`);
    filters.push(`(name ILIKE $${params.length} OR breed ILIKE $${params.length})`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM pets ${whereClause} ORDER BY created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/pets/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pets WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Pet not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/pets", async (req, res) => {
  const parsed = createPetSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { customer_id, name, breed, size, notes } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO pets (customer_id, name, breed, size, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [customer_id, name, breed ?? null, size ?? null, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/pets/:id", async (req, res) => {
  const parsed = updatePetSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["customer_id", "name", "breed", "size", "notes"],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE pets SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Pet not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/pets/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM pets WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Pet not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/service-types", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM service_types ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/service-types/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM service_types WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Service type not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/service-types", async (req, res) => {
  const parsed = createServiceTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name, default_price } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO service_types (name, default_price)
       VALUES ($1, $2)
       RETURNING *`,
      [name, default_price ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/service-types/:id", async (req, res) => {
  const parsed = updateServiceTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(["name", "default_price"], updates);

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE service_types SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service type not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/service-types/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM service_types WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Service type not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/payment-methods", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM payment_methods ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/payment-methods/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM payment_methods WHERE id = $1",
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, "Payment method not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/payment-methods", async (req, res) => {
  const parsed = createPaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO payment_methods (name)
       VALUES ($1)
       RETURNING *`,
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/payment-methods/:id", async (req, res) => {
  const parsed = updatePaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(["name"], updates);

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE payment_methods SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Payment method not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/payment-methods/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM payment_methods WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Payment method not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/services", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM services ORDER BY date DESC, created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/services/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM services WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/services", async (req, res) => {
  const parsed = createServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const {
    date,
    pet_id,
    customer_id,
    service_type_id,
    price,
    payment_method_id,
    groomer_id,
    notes
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO services
        (date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        date,
        pet_id,
        customer_id,
        service_type_id,
        price,
        payment_method_id,
        groomer_id ?? null,
        notes ?? null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/services/:id", async (req, res) => {
  const parsed = updateServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    [
      "date",
      "pet_id",
      "customer_id",
      "service_type_id",
      "price",
      "payment_method_id",
      "groomer_id",
      "notes"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE services SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/services/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM services WHERE id = $1", [
      req.params.id
    ]);

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/suppliers", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM suppliers ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/suppliers/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM suppliers WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Supplier not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/suppliers", async (req, res) => {
  const parsed = createSupplierSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name, category, phone, payment_method_id, notes } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO suppliers (name, category, phone, payment_method_id, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, category ?? null, phone ?? null, payment_method_id ?? null, notes ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/suppliers/:id", async (req, res) => {
  const parsed = updateSupplierSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["name", "category", "phone", "payment_method_id", "notes"],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE suppliers SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Supplier not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/suppliers/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM suppliers WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Supplier not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/expense-categories", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expense_categories ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/expense-categories/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expense_categories WHERE id = $1",
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, "Expense category not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/expense-categories", async (req, res) => {
  const parsed = createExpenseCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { name } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO expense_categories (name)
       VALUES ($1)
       RETURNING *`,
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/expense-categories/:id", async (req, res) => {
  const parsed = updateExpenseCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(["name"], updates);

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE expense_categories SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Expense category not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/expense-categories/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM expense_categories WHERE id = $1",
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, "Expense category not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/daily-expenses", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const categoryId =
    typeof req.query.category_id === "string" ? req.query.category_id.trim() : "";
  const filters = [];
  const params = [];

  if (from) {
    params.push(from);
    filters.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`date <= $${params.length}`);
  }

  if (categoryId) {
    params.push(categoryId);
    filters.push(`category_id = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM daily_expenses ${whereClause} ORDER BY date DESC, created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/daily-expenses/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM daily_expenses WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Daily expense not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/daily-expenses", async (req, res) => {
  const parsed = createDailyExpenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { date, category_id, description, amount, payment_method_id, supplier_id } =
    parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO daily_expenses
        (date, category_id, description, amount, payment_method_id, supplier_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        date,
        category_id,
        description,
        amount,
        payment_method_id,
        supplier_id ?? null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/daily-expenses/:id", async (req, res) => {
  const parsed = updateDailyExpenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    [
      "date",
      "category_id",
      "description",
      "amount",
      "payment_method_id",
      "supplier_id"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE daily_expenses SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Daily expense not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/daily-expenses/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM daily_expenses WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Daily expense not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/fixed-expenses", async (req, res) => {
  const categoryId =
    typeof req.query.category_id === "string" ? req.query.category_id.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const filters = [];
  const params = [];

  if (categoryId) {
    params.push(categoryId);
    filters.push(`category_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM fixed_expenses ${whereClause} ORDER BY created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/fixed-expenses/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fixed_expenses WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Fixed expense not found");
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/fixed-expenses", async (req, res) => {
  const parsed = createFixedExpenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const {
    name,
    category_id,
    amount,
    due_day,
    payment_method_id,
    supplier_id,
    status
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO fixed_expenses
        (name, category_id, amount, due_day, payment_method_id, supplier_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        name,
        category_id,
        amount,
        due_day,
        payment_method_id,
        supplier_id ?? null,
        status
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/fixed-expenses/:id", async (req, res) => {
  const parsed = updateFixedExpenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    [
      "name",
      "category_id",
      "amount",
      "due_day",
      "payment_method_id",
      "supplier_id",
      "status"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE fixed_expenses SET ${fields.join(", ")}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Fixed expense not found");
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/fixed-expenses/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM fixed_expenses WHERE id = $1", [
      req.params.id
    ]);
    if (result.rowCount === 0) {
      return sendError(res, 404, "Fixed expense not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  sendError(res, 500, "Unexpected error");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API running on :${port}`);
});
