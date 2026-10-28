// Equipo: organigrama y personal, adaptado del módulo Equipo de la ONG.
// Solo el admin del local: quién ocupa cada puesto es una decisión suya, y el
// personal tiene DNI y teléfonos. Ver 031_equipo_organigrama.sql: el puesto
// es la caja, la persona es la fila de `employees` y el permiso sigue en
// users.role.
import { z } from "zod";

export const TEAM_AREAS = ["direccion", "administracion", "recepcion", "peluqueria", "bandimoviles", "petshop", "otro"];

const uuid = z.string().uuid();
const emptyToNull = (value) => (typeof value === "string" && value.trim() === "" ? null : value);
const name = z.string().trim().min(1).max(80);
const description = z.preprocess(emptyToNull, z.string().trim().max(300).nullable().optional());

const createSchema = z
  .object({ name, description, area: z.enum(TEAM_AREAS).optional(), parent_id: uuid.nullable().optional() })
  .strict();
const updateSchema = z
  .object({
    name: name.optional(),
    description,
    area: z.enum(TEAM_AREAS).optional(),
    parent_id: uuid.nullable().optional(),
    sort_order: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const assignSchema = z.object({ employee_ids: z.array(uuid).max(200) }).strict();

class TeamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendTeamError(res, err) {
  if (err instanceof TeamError) return res.status(err.status).json({ status: err.status, message: err.message });
  if (err?.code === "23503") {
    return res.status(409).json({ status: 409, message: "Este puesto tiene otros puestos debajo. Movelos a otro lugar antes de borrarlo." });
  }
  console.error(err);
  return res.status(500).json({ status: 500, message: "Unexpected error" });
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

// Sube desde el nuevo jefe hasta la raíz: si en el camino aparece el propio
// puesto, guardar lo dejaría colgando de sí mismo (A→B→A) y el árbol no se
// podría dibujar.
export function createsCycle(positions, positionId, newParentId) {
  const parentOf = new Map(positions.map((p) => [String(p.id), p.parent_id ? String(p.parent_id) : null]));
  let current = newParentId ? String(newParentId) : null;
  for (let steps = 0; current && steps <= positions.length; steps += 1) {
    if (current === String(positionId)) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}

async function loadTeam(db, tenantId) {
  const [positions, employees, assignments] = await Promise.all([
    db.query(
      `SELECT id, name, description, area, parent_id, sort_order
       FROM team_positions WHERE tenant_id = $1 ORDER BY sort_order, name`,
      [tenantId]
    ),
    db.query(
      `SELECT id, name, role, phone, email, status, notes, is_driver, dni, hire_date::text AS hire_date, end_date::text AS end_date
       FROM employees WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    ),
    db.query(`SELECT position_id, employee_id FROM team_assignments WHERE tenant_id = $1`, [tenantId]),
  ]);
  return { positions: positions.rows, employees: employees.rows, assignments: assignments.rows };
}

async function positionsOf(db, tenantId) {
  return (await db.query(`SELECT id, parent_id FROM team_positions WHERE tenant_id = $1`, [tenantId])).rows;
}

async function assertParent(db, tenantId, parentId) {
  if (!parentId) return;
  const r = await db.query(`SELECT 1 FROM team_positions WHERE tenant_id = $1 AND id = $2`, [tenantId, parentId]);
  if (!r.rows.length) throw new TeamError(400, "El puesto del que depende no existe en este local.");
}

async function nextSortOrder(db, tenantId, parentId) {
  const r = await db.query(
    `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM team_positions
     WHERE tenant_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [tenantId, parentId ?? null]
  );
  return Number(r.rows[0].next);
}

// Organigrama sugerido para una peluquería, con cada integrante activo
// ubicado según su rol actual. Solo si todavía no hay puestos.
const TEMPLATE = [
  { key: "direccion", name: "Dirección", area: "direccion", parent: null, description: "Define el rumbo del negocio, aprueba y decide quién ocupa cada puesto." },
  { key: "administracion", name: "Administración", area: "administracion", parent: "direccion", description: "Caja, gastos, proveedores y sueldos." },
  { key: "recepcion", name: "Recepción", area: "recepcion", parent: "direccion", description: "Atiende clientes, agenda turnos y cobra." },
  { key: "peluqueria", name: "Peluquería", area: "peluqueria", parent: "recepcion", description: "Baño, corte y cuidado de cada mascota." },
  { key: "bandimoviles", name: "Bandimóviles", area: "bandimoviles", parent: "recepcion", description: "Busca y lleva a las mascotas a domicilio." },
  { key: "petshop", name: "PetShop", area: "petshop", parent: "recepcion", description: "Venta de productos, stock y conteo." },
];

function templateKeysFor(employee) {
  const role = String(employee.role || "").toLowerCase();
  const keys = new Set();
  if (role.includes("socio") || role.includes("due")) keys.add("direccion");
  if (role.includes("admin")) keys.add("administracion");
  if (role.includes("recep")) keys.add("recepcion");
  if (role.includes("groom") || role.includes("ayud") || role.includes("peluq") || role.includes("estil")) keys.add("peluqueria");
  if (role.includes("chofer") || employee.is_driver) keys.add("bandimoviles");
  if (role.includes("petshop") || role.includes("venta")) keys.add("petshop");
  return [...keys];
}

export function registerTeamRoutes(app, pool, requireRole) {
  const admin = requireRole("admin");
  const tenantOrFail = (req, res) => {
    if (req.tenantId) return true;
    res.status(403).json({ status: 403, message: "No tenant context" });
    return false;
  };

  // Todo lo que el organigrama necesita en un solo pedido: son decenas de
  // cajas, no miles, y el árbol se arma en el cliente.
  app.get("/v2/team", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    try {
      res.json(await loadTeam(pool, req.tenantId));
    } catch (err) {
      sendTeamError(res, err);
    }
  });

  app.post("/v2/team/positions", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendTeamError(res, new TeamError(400, "El puesto necesita un nombre."));
    const input = parsed.data;
    try {
      const row = await transaction(pool, async (db) => {
        await assertParent(db, req.tenantId, input.parent_id);
        // Al final de sus hermanos: el que se agrega aparece a la derecha.
        const sortOrder = await nextSortOrder(db, req.tenantId, input.parent_id);
        const r = await db.query(
          `INSERT INTO team_positions (tenant_id, name, description, area, parent_id, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, description, area, parent_id, sort_order`,
          [req.tenantId, input.name, input.description ?? null, input.area ?? "otro", input.parent_id ?? null, sortOrder]
        );
        return r.rows[0];
      });
      res.status(201).json(row);
    } catch (err) {
      sendTeamError(res, err);
    }
  });

  app.patch("/v2/team/positions/:id", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    const id = uuid.safeParse(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return sendTeamError(res, new TeamError(400, "Revisá los datos del puesto."));
    const input = parsed.data;
    if (Object.keys(input).length === 0) return sendTeamError(res, new TeamError(400, "No hay cambios."));
    try {
      const row = await transaction(pool, async (db) => {
        // Serializa los cambios de jefe: dos movimientos cruzados a la vez
        // podrían armar un ciclo que ninguno de los dos ve por separado.
        await db.query(`SELECT id FROM team_positions WHERE tenant_id = $1 ORDER BY id FOR UPDATE`, [req.tenantId]);
        if ("parent_id" in input) {
          if (input.parent_id === id.data) throw new TeamError(400, "Un puesto no puede depender de sí mismo.");
          await assertParent(db, req.tenantId, input.parent_id);
          if (input.parent_id && createsCycle(await positionsOf(db, req.tenantId), id.data, input.parent_id)) {
            throw new TeamError(400, "Ese puesto está debajo de este: moverlo ahí dejaría el organigrama en círculo.");
          }
        }
        const fields = [];
        const values = [];
        for (const key of ["name", "description", "area", "parent_id", "sort_order"]) {
          if (key in input) fields.push(`${key} = $${values.push(input[key] ?? null)}`);
        }
        const r = await db.query(
          `UPDATE team_positions SET ${fields.join(", ")}, updated_at = now()
           WHERE tenant_id = $${values.push(req.tenantId)} AND id = $${values.push(id.data)}
           RETURNING id, name, description, area, parent_id, sort_order`,
          values
        );
        if (!r.rows.length) throw new TeamError(404, "Puesto no encontrado.");
        return r.rows[0];
      });
      res.json(row);
    } catch (err) {
      sendTeamError(res, err);
    }
  });

  app.delete("/v2/team/positions/:id", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return sendTeamError(res, new TeamError(404, "Puesto no encontrado."));
    try {
      await transaction(pool, async (db) => {
        const children = await db.query(
          `SELECT 1 FROM team_positions WHERE tenant_id = $1 AND parent_id = $2 LIMIT 1`,
          [req.tenantId, id.data]
        );
        if (children.rows.length) {
          throw new TeamError(409, "Este puesto tiene otros puestos debajo. Movelos a otro lugar antes de borrarlo.");
        }
        // Las asignaciones se van en cascada; las personas quedan en el personal.
        const r = await db.query(`DELETE FROM team_positions WHERE tenant_id = $1 AND id = $2`, [req.tenantId, id.data]);
        if (!r.rowCount) throw new TeamError(404, "Puesto no encontrado.");
      });
      res.json({ ok: true });
    } catch (err) {
      sendTeamError(res, err);
    }
  });

  // Quiénes ocupan el puesto, de una vez: se manda la lista entera, así lo que
  // se ve al guardar es lo que queda.
  app.put("/v2/team/positions/:id/employees", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    const id = uuid.safeParse(req.params.id);
    const parsed = assignSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return sendTeamError(res, new TeamError(400, "Revisá las personas elegidas."));
    const employeeIds = [...new Set(parsed.data.employee_ids)];
    try {
      await transaction(pool, async (db) => {
        const position = await db.query(
          `SELECT id FROM team_positions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [req.tenantId, id.data]
        );
        if (!position.rows.length) throw new TeamError(404, "Puesto no encontrado.");
        if (employeeIds.length) {
          const active = await db.query(
            `SELECT id FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
            [req.tenantId, employeeIds]
          );
          if (active.rows.length !== employeeIds.length) {
            throw new TeamError(400, "Solo se pueden asignar personas activas del equipo.");
          }
        }
        await db.query(`DELETE FROM team_assignments WHERE tenant_id = $1 AND position_id = $2`, [req.tenantId, id.data]);
        for (const employeeId of employeeIds) {
          await db.query(
            `INSERT INTO team_assignments (tenant_id, position_id, employee_id) VALUES ($1, $2, $3)`,
            [req.tenantId, id.data, employeeId]
          );
        }
      });
      res.json({ ok: true });
    } catch (err) {
      sendTeamError(res, err);
    }
  });

  app.post("/v2/team/template", admin, async (req, res) => {
    if (!tenantOrFail(req, res)) return;
    try {
      await transaction(pool, async (db) => {
        // Bloquea el local: dos clics seguidos no arman dos organigramas.
        await db.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [req.tenantId]);
        const existing = await db.query(`SELECT 1 FROM team_positions WHERE tenant_id = $1 LIMIT 1`, [req.tenantId]);
        if (existing.rows.length) throw new TeamError(409, "El organigrama ya tiene puestos.");
        const ids = {};
        const siblings = {};
        for (const item of TEMPLATE) {
          const parentId = item.parent ? ids[item.parent] : null;
          const order = siblings[item.parent ?? "root"] ?? 0;
          siblings[item.parent ?? "root"] = order + 1;
          const r = await db.query(
            `INSERT INTO team_positions (tenant_id, name, description, area, parent_id, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.tenantId, item.name, item.description, item.area, parentId, order]
          );
          ids[item.key] = r.rows[0].id;
        }
        const employees = await db.query(
          `SELECT id, role, is_driver FROM employees WHERE tenant_id = $1 AND status = 'active'`,
          [req.tenantId]
        );
        for (const employee of employees.rows) {
          for (const key of templateKeysFor(employee)) {
            await db.query(
              `INSERT INTO team_assignments (tenant_id, position_id, employee_id) VALUES ($1, $2, $3)`,
              [req.tenantId, ids[key], employee.id]
            );
          }
        }
      });
      res.status(201).json(await loadTeam(pool, req.tenantId));
    } catch (err) {
      sendTeamError(res, err);
    }
  });
}
