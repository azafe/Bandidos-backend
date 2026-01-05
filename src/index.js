import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { pool } from "./db.js";

const app = express();

const corsOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const createServiceSchema = z.object({
  date: z.string().min(1),
  dog_name: z.string().min(1),
  owner_name: z.string().min(1),
  type: z.string().min(1),
  price: z.coerce.number().min(0).default(0),
  payment_method: z.string().min(1),
  groomer: z.string().min(1).optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const updateServiceSchema = z.object({
  date: z.string().min(1).optional(),
  dog_name: z.string().min(1).optional(),
  owner_name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  price: z.coerce.number().min(0).optional(),
  payment_method: z.string().min(1).optional(),
  groomer: z.string().min(1).optional().nullable(),
  notes: z.string().min(1).optional().nullable()
});

const sendError = (res, status, message) => {
  return res.status(status).json({ status, message });
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/services", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM servicios ORDER BY date DESC, created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/services", async (req, res) => {
  const parsed = createServiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { date, dog_name, owner_name, type, price, payment_method, groomer, notes } =
    parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO servicios
        (date, dog_name, owner_name, type, price, payment_method, groomer, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [date, dog_name, owner_name, type, price, payment_method, groomer ?? null, notes ?? null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/services/:id", async (req, res) => {
  const parsed = updateServiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE servicios SET ${fields.join(", ")}
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
    const result = await pool.query("DELETE FROM servicios WHERE id = $1", [
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

app.use((err, _req, res, _next) => {
  console.error(err);
  sendError(res, 500, "Unexpected error");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API running on :${port}`);
});
