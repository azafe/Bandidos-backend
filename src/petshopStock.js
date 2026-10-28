// Stock del PetShop con conteo, adaptado del módulo de stock de la ONG.
// Cada cambio de stock deja un movimiento con su tipo, la diferencia aplicada,
// el saldo resultante y quién lo hizo, así el historial explica el número.
// El conteo es "a ciegas": se guarda lo que hay en el estante y la diferencia
// contra el sistema exige un motivo, que después se ve en la revisión.
import { z } from "zod";

export const STOCK_KINDS = ["ingreso", "venta", "devolucion", "ajuste", "merma", "conteo", "inicial"];

// Cuántos días atrás muestra la revisión las diferencias de los conteos, y
// desde cuántos días sin contar un producto con stock pide recontarse.
export const REVIEW_DAYS = 30;
export const RECOUNT_DAYS = 30;

const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const emptyToNull = (value) => (typeof value === "string" && value.trim() === "" ? null : value);

const movementSchema = z
  .object({
    client_id: z.string().uuid().optional(),
    product_id: z.string().uuid(),
    kind: z.enum(["ingreso", "merma", "conteo"]),
    quantity: z.coerce.number().int().min(0).max(1_000_000),
    unit_cost: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9_999_999_999).nullable().optional()),
    note: z.preprocess(emptyToNull, z.string().trim().min(1).max(300).nullable().optional()),
  })
  .strict()
  .refine((m) => m.kind === "conteo" || m.quantity > 0, { message: "quantity" });

const listSchema = z
  .object({
    product_id: z.string().uuid().optional(),
    kind: z.string().optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .passthrough();

export class StockError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// La columna `type` (in/out/adjust) es la de antes: se sigue completando con
// el mismo sentido para que nada que la lea cambie. `adjust` guarda el saldo
// resultante en `quantity`, igual que antes.
function legacyType(kind, delta) {
  if (kind === "conteo" || kind === "ajuste") return "adjust";
  return delta >= 0 ? "in" : "out";
}

// Registra un movimiento DESPUÉS de haber actualizado el stock del producto,
// dentro de la misma transacción: el saldo resultante sale de la fila ya
// actualizada.
export async function recordStockMovement(db, {
  tenantId,
  productId,
  kind,
  delta,
  userId = null,
  saleId = null,
  note = null,
  unitCost = null,
  clientId = null,
  date = null,
}) {
  const type = legacyType(kind, delta);
  const result = await db.query(
    `INSERT INTO petshop_stock_movements
       (date, product_id, type, quantity, kind, delta, stock_after, unit_cost, user_id, sale_id, note, client_id, tenant_id)
     SELECT $1, p.id, $2, CASE WHEN $2 = 'adjust' THEN p.stock ELSE $3 END, $4, $5, p.stock, $6, $7, $8, $9, $10, p.tenant_id
     FROM petshop_products p
     WHERE p.id = $11 AND p.tenant_id = $12
     RETURNING *`,
    [date ?? today(), type, Math.abs(delta), kind, delta, unitCost, userId, saleId, note, clientId, productId, tenantId]
  );
  return result.rows[0] || null;
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

function mapMovement(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    product_name: row.product_name ?? null,
    kind: row.kind,
    delta: toNumber(row.delta),
    stock_after: toNumber(row.stock_after),
    quantity: toNumber(row.quantity),
    unit_cost: toNumber(row.unit_cost),
    note: row.note,
    sale_id: row.sale_id,
    user_email: row.user_email ?? null,
    date: row.date,
    created_at: row.created_at,
  };
}

async function registerMovement(db, tenantId, userId, input) {
  if (input.client_id) {
    const existing = await db.query(
      `SELECT m.*, p.name AS product_name FROM petshop_stock_movements m
       JOIN petshop_products p ON p.id = m.product_id
       WHERE m.tenant_id = $1 AND m.client_id = $2`,
      [tenantId, input.client_id]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      const same =
        String(row.product_id) === input.product_id &&
        row.kind === input.kind &&
        (input.kind === "conteo" ? Number(row.stock_after) === input.quantity : Math.abs(Number(row.delta)) === input.quantity);
      if (!same) throw new StockError(409, "Ese movimiento ya se registró con otros datos.");
      return { movement: mapMovement(row), stock: Number(row.stock_after), replayed: true };
    }
  }

  const locked = await db.query(
    `SELECT id, stock FROM petshop_products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [input.product_id, tenantId]
  );
  if (!locked.rows.length) throw new StockError(404, "Producto no encontrado en este local.");
  const current = Number(locked.rows[0].stock);

  let delta;
  if (input.kind === "ingreso") delta = input.quantity;
  else if (input.kind === "merma") delta = -input.quantity;
  else delta = input.quantity - current;

  // Lo contado no coincide con el sistema: hay que decir por qué.
  if (input.kind === "conteo" && delta !== 0 && !input.note) {
    throw new StockError(422, "Lo contado no coincide con el sistema. Indicá el motivo de la diferencia.", { stock: current });
  }
  if (input.kind === "merma" && !input.note) {
    throw new StockError(422, "Indicá por qué se dio de baja (vencido, roto, consumo interno…).");
  }

  await db.query(
    `UPDATE petshop_products
     SET stock = stock + $1,
         ${input.kind === "conteo" ? "last_counted_at = now()," : ""}
         updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [delta, input.product_id, tenantId]
  );
  const row = await recordStockMovement(db, {
    tenantId,
    productId: input.product_id,
    kind: input.kind,
    delta,
    userId,
    note: input.note ?? null,
    unitCost: input.kind === "ingreso" ? input.unit_cost ?? null : null,
    clientId: input.client_id ?? null,
  });
  return { movement: mapMovement(row), stock: current + delta, replayed: false };
}

function sendStockError(res, err) {
  if (err instanceof StockError) {
    return res.status(err.status).json({ status: err.status, message: err.message, ...err.extra });
  }
  // Dos reintentos simultáneos con el mismo client_id: gana uno.
  if (err?.code === "23505") {
    return res.status(409).json({ status: 409, message: "Ese movimiento ya se estaba registrando. Actualizá la pantalla." });
  }
  console.error(err);
  return res.status(500).json({ status: 500, message: "Unexpected error" });
}

export function registerPetshopStockRoutes(app, pool) {
  // Saldo de cada producto con lo que hace falta para decidir qué contar.
  app.get("/v2/petshop/stock", async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    try {
      const result = await pool.query(
        `SELECT p.id, p.name, p.sku, p.category, p.cost, p.price, p.stock, p.stock_min, p.last_counted_at,
                (SELECT m.unit_cost FROM petshop_stock_movements m
                  WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND m.kind = 'ingreso' AND m.unit_cost IS NOT NULL
                  ORDER BY m.created_at DESC LIMIT 1) AS last_cost,
                COALESCE((SELECT SUM(si.quantity) FROM petshop_sale_items si
                  JOIN petshop_sales s ON s.id = si.sale_id
                  WHERE s.tenant_id = p.tenant_id AND si.product_id = p.id AND s.date >= $2::date - 30), 0) AS sold_30d
         FROM petshop_products p
         WHERE p.tenant_id = $1
         ORDER BY p.name`,
        [req.tenantId, today()]
      );
      res.json({
        items: result.rows.map((row) => ({
          ...row,
          cost: toNumber(row.cost),
          price: toNumber(row.price),
          stock: Number(row.stock),
          stock_min: Number(row.stock_min),
          last_cost: toNumber(row.last_cost),
          sold_30d: Number(row.sold_30d),
        })),
      });
    } catch (err) {
      sendStockError(res, err);
    }
  });

  // Historial (kardex): por producto, tipo y fechas.
  app.get("/v2/petshop/stock/movements", async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ status: 400, message: "Filtros inválidos" });
    const q = parsed.data;
    const kinds = (q.kind || "").split(",").map((k) => k.trim()).filter(Boolean);
    if (kinds.some((k) => !STOCK_KINDS.includes(k))) return res.status(400).json({ status: 400, message: "Tipo inválido" });

    const params = [req.tenantId];
    const where = ["m.tenant_id = $1"];
    if (q.product_id) where.push(`m.product_id = $${params.push(q.product_id)}`);
    if (kinds.length) where.push(`m.kind = ANY($${params.push(kinds)}::text[])`);
    if (q.from) where.push(`m.created_at >= ($${params.push(q.from)}::date)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'`);
    if (q.to) where.push(`m.created_at < ($${params.push(q.to)}::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires'`);
    try {
      const result = await pool.query(
        `SELECT m.*, p.name AS product_name, u.email AS user_email
         FROM petshop_stock_movements m
         JOIN petshop_products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.created_at DESC, m.id
         LIMIT ${q.limit ?? 200}`,
        params
      );
      res.json({ items: result.rows.map(mapMovement) });
    } catch (err) {
      sendStockError(res, err);
    }
  });

  // Ingreso, baja (merma) o conteo de un producto.
  app.post("/v2/petshop/stock/movements", async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ status: 400, message: "Revisá el producto y la cantidad." });
    try {
      const result = await transaction(pool, (db) => registerMovement(db, req.tenantId, req.user?.sub ?? null, parsed.data));
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      sendStockError(res, err);
    }
  });

  // Lo que hay que mirar para que el sistema coincida con el estante.
  app.get("/v2/petshop/stock/review", async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    try {
      const [products, differences] = await Promise.all([
        pool.query(
          `SELECT id, name, stock, stock_min, cost, last_counted_at FROM petshop_products WHERE tenant_id = $1 ORDER BY name`,
          [req.tenantId]
        ),
        pool.query(
          `SELECT m.id, m.product_id, p.name AS product_name, m.delta, m.stock_after, m.note, m.created_at,
                  u.email AS user_email, p.cost
           FROM petshop_stock_movements m
           JOIN petshop_products p ON p.id = m.product_id
           LEFT JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 AND m.kind = 'conteo' AND m.delta <> 0
             AND m.created_at >= now() - ($2 || ' days')::interval
           ORDER BY m.created_at DESC`,
          [req.tenantId, String(REVIEW_DAYS)]
        ),
      ]);
      const now = Date.now();
      const rows = products.rows.map((p) => ({
        id: p.id,
        name: p.name,
        stock: Number(p.stock),
        stock_min: Number(p.stock_min),
        last_counted_at: p.last_counted_at,
      }));
      const diffs = differences.rows.map((d) => ({
        id: d.id,
        product_id: d.product_id,
        product_name: d.product_name,
        delta: Number(d.delta),
        stock_after: toNumber(d.stock_after),
        note: d.note,
        user_email: d.user_email,
        created_at: d.created_at,
        value: Number(d.delta) * Number(d.cost || 0),
      }));
      res.json({
        review_days: REVIEW_DAYS,
        recount_days: RECOUNT_DAYS,
        negatives: rows.filter((p) => p.stock < 0),
        never_counted: rows.filter((p) => !p.last_counted_at),
        recount: rows.filter(
          (p) => p.last_counted_at && p.stock > 0 && now - new Date(p.last_counted_at).getTime() > RECOUNT_DAYS * 86_400_000
        ),
        below_min: rows.filter((p) => p.stock_min > 0 && p.stock >= 0 && p.stock <= p.stock_min),
        differences: diffs,
        // Valor a costo de lo que faltó (negativo) o sobró en los conteos.
        differences_value: diffs.reduce((sum, d) => sum + d.value, 0),
      });
    } catch (err) {
      sendStockError(res, err);
    }
  });
}
