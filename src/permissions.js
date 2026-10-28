// Roles y permisos por módulo, adaptado del módulo Permisos de la ONG.
//
// Qué módulo abre cada rol lo decide el admin de cada local desde Usuarios ›
// Permisos (tabla tenant_role_permissions, migración 033). Admin entra a todo
// siempre y es el único que edita permisos y usuarios: si eso se pudiera dar
// como módulo, cualquiera con él se daría todo lo demás.
//
// El backend es quien hace cumplir cada módulo: enforceModules mira cada
// pedido contra MODULE_RULES. El panel usa la misma lista para armar el menú
// y no ofrecer pantallas que se van a llenar de 403.
import { z } from "zod";

export const MODULES = [
  { id: "inicio", label: "Inicio y Nueva sucursal", group: "Negocio", description: "Tablero con ingresos, gastos y ganancia, asistente y cálculo de nueva sucursal." },
  { id: "servicios", label: "Servicios", group: "Negocio", description: "Listado de servicios realizados y su edición." },
  { id: "agenda", label: "Agenda", group: "Operación", description: "Turnos del día: crear, mover, finalizar y cobrar." },
  { id: "reservas", label: "Reservas online", group: "Operación", description: "Configurar la página de reservas, horarios y días cerrados." },
  { id: "bandimoviles", label: "Bandimóviles", group: "Operación", description: "Traslados, recorrido del día y cobros. Resultados, rendiciones y configuración siguen siendo del admin." },
  { id: "mascotas", label: "Mascotas y clientes", group: "Clientes", description: "Fichas de mascotas y clientes: alta, edición, fotos y archivo." },
  { id: "comunicaciones", label: "Comunicaciones", group: "Clientes", description: "Recordatorios y mensajes de WhatsApp a clientes." },
  { id: "petshop", label: "PetShop", group: "PetShop", description: "Ventas, productos, stock y conteo." },
  { id: "caja", label: "Rendición de caja", group: "Dinero", description: "Cierre de caja del día por medio de pago." },
  { id: "gastos", label: "Gastos diarios", group: "Dinero", description: "Registrar y ver los gastos del día." },
  { id: "gastos_fijos", label: "Gastos fijos", group: "Dinero", description: "Alquiler, sueldos y servicios de cada mes." },
  { id: "proveedores", label: "Proveedores", group: "Dinero", description: "Proveedores, cuentas y pagos." },
  { id: "tipos_servicio", label: "Tipos de servicio", group: "Configuración", description: "Servicios que se ofrecen, precios y duración." },
  { id: "configuracion", label: "Métodos de pago y categorías", group: "Configuración", description: "Métodos de pago y categorías de gastos." },
  { id: "equipo", label: "Equipo", group: "Configuración", description: "Organigrama y personal, con DNI y teléfonos." },
];

export const MODULE_IDS = MODULES.map((m) => m.id);

// Los roles a los que el admin les da módulos. 'user' es un rol viejo que
// funciona igual que Staff.
export const CONFIGURABLE_ROLES = ["staff", "recepcion", "peluquero", "administracion"];
export const ROLE_LABELS = {
  admin: "Administrador",
  staff: "Staff",
  recepcion: "Recepción",
  peluquero: "Peluquero/a",
  administracion: "Administración",
  user: "Staff",
};
export const ASSIGNABLE_ROLES = ["admin", ...CONFIGURABLE_ROLES, "user"];

// Con qué arranca cada rol si el local todavía no lo configuró. Staff es
// exactamente lo que veía antes de que existieran los permisos.
export const DEFAULT_PERMISSIONS = {
  staff: ["agenda", "bandimoviles", "comunicaciones", "mascotas", "petshop", "caja", "gastos", "tipos_servicio"],
  recepcion: ["agenda", "bandimoviles", "comunicaciones", "mascotas", "petshop", "caja"],
  peluquero: ["agenda", "mascotas"],
  administracion: ["inicio", "servicios", "caja", "gastos", "gastos_fijos", "proveedores", "petshop", "tipos_servicio", "configuracion", "equipo"],
};

const READ = ["GET", "HEAD"];
const WRITE = ["POST", "PUT", "PATCH", "DELETE"];
const ANY = [...READ, ...WRITE];
const ADMIN_ONLY = "admin";
const OPEN = null;

// Qué módulo hace falta para cada pedido. Gana la primera regla que coincide,
// así que lo específico va antes. Sin regla, el pedido queda abierto a
// cualquier usuario del local: son las listas de referencia que usan varias
// pantallas (empleados, mascotas, clientes, métodos de pago, tipos de
// servicio, la agenda) y las rutas propias de la sesión.
export const MODULE_RULES = [
  { methods: ANY, pattern: /^\/v2\/(users|permissions)(\/|$)/, modules: ADMIN_ONLY },

  { methods: READ, pattern: /^\/reports(\/|$)/, modules: ["inicio"] },
  { methods: ANY, pattern: /^\/v2\/assistant(\/|$)/, modules: ["inicio"] },

  { methods: READ, pattern: /^\/v2\/fixed-expenses(\/|$)/, modules: ["gastos_fijos", "inicio"] },
  { methods: ANY, pattern: /^\/v2\/fixed-expenses(\/|$)/, modules: ["gastos_fijos"] },
  { methods: READ, pattern: /^\/v2\/daily-expenses(\/|$)/, modules: ["gastos", "inicio"] },
  { methods: ANY, pattern: /^\/v2\/daily-expenses(\/|$)/, modules: ["gastos"] },
  { methods: ANY, pattern: /^\/v2\/daily-incomes(\/|$)/, modules: ["caja"] },

  { methods: READ, pattern: /^\/v2\/petshop\/sales(\/|$)/, modules: ["petshop", "inicio"] },
  { methods: ANY, pattern: /^\/v2\/petshop(\/|$)/, modules: ["petshop"] },

  { methods: READ, pattern: /^\/v2\/traslado-solicitudes\/cobrados$/, modules: ["bandimoviles", "inicio"] },
  { methods: READ, pattern: /^\/v2\/traslados\/resultados(\/|$)/, modules: ["bandimoviles", "inicio"] },
  { methods: ANY, pattern: /^\/v2\/(traslado-solicitudes|traslados|traslado-zonas)(\/|$)/, modules: ["bandimoviles"] },
  { methods: WRITE, pattern: /^\/v2\/vehiculos(\/|$)/, modules: ["bandimoviles"] },

  { methods: READ, pattern: /^\/v2\/booking\/link$/, modules: OPEN },
  { methods: ANY, pattern: /^\/v2\/agenda\/blocks(\/|$)/, modules: ["reservas", "agenda"] },
  { methods: ANY, pattern: /^\/v2\/booking(\/|$)/, modules: ["reservas"] },
  { methods: WRITE, pattern: /^\/(v2\/)?agenda(\/|$)/, modules: ["agenda"] },

  // Finalizar un turno registra el servicio: la Agenda también lo crea y lo lee.
  { methods: [...READ, "POST"], pattern: /^\/(v2\/)?services(\/|$)/, modules: ["servicios", "agenda"] },
  { methods: ANY, pattern: /^\/(v2\/)?services(\/|$)/, modules: ["servicios"] },

  { methods: ANY, pattern: /^\/v2\/comunicaciones(\/|$)/, modules: ["comunicaciones"] },
  { methods: WRITE, pattern: /^\/v2\/(pets|customers)(\/|$)/, modules: ["mascotas"] },

  { methods: WRITE, pattern: /^\/v2\/service-types(\/|$)/, modules: ["tipos_servicio"] },
  { methods: WRITE, pattern: /^\/v2\/(payment-methods|expense-categories)(\/|$)/, modules: ["configuracion"] },

  // La lista de proveedores la usan Gastos diarios y PetShop; el detalle,
  // los movimientos y los cambios son del módulo.
  { methods: READ, pattern: /^\/v2\/suppliers$/, modules: OPEN },
  { methods: ANY, pattern: /^\/v2\/(suppliers|supplier-movements)(\/|$)/, modules: ["proveedores"] },

  { methods: WRITE, pattern: /^\/v2\/employees(\/|$)/, modules: ["equipo"] },
  { methods: ANY, pattern: /^\/v2\/team(\/|$)/, modules: ["equipo"] },
];

export function ruleFor(method, path) {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return MODULE_RULES.find((rule) => rule.methods.includes(method) && rule.pattern.test(clean)) ?? null;
}

const isAdmin = (role) => role === "admin" || role === "super_admin";

function sanitize(modules) {
  return [...new Set((modules || []).filter((m) => MODULE_IDS.includes(m)))];
}

// { rol: [módulos] } del local, con los valores por defecto para los roles que
// todavía no configuró.
// La tabla todavía no existe si el backend salió antes que la migración 033:
// cada rol usa sus permisos por defecto, así nadie pierde lo que tenía.
const missingTable = (err) => err?.code === "42P01";

async function queryPermissions(db, sql, params) {
  try {
    return await db.query(sql, params);
  } catch (err) {
    if (missingTable(err)) return { rows: [] };
    throw err;
  }
}

export async function loadPermissions(db, tenantId) {
  const r = await queryPermissions(db, `SELECT role, modules FROM tenant_role_permissions WHERE tenant_id = $1`, [tenantId]);
  const saved = new Map(r.rows.map((row) => [row.role, sanitize(row.modules)]));
  return Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, saved.get(role) ?? DEFAULT_PERMISSIONS[role]]));
}

export async function modulesForRole(db, tenantId, role) {
  if (isAdmin(role)) return MODULE_IDS;
  const configurable = role === "user" ? "staff" : role;
  if (!CONFIGURABLE_ROLES.includes(configurable)) return [];
  const r = await queryPermissions(
    db,
    `SELECT modules FROM tenant_role_permissions WHERE tenant_id = $1 AND role = $2`,
    [tenantId, configurable]
  );
  return r.rows.length ? sanitize(r.rows[0].modules) : DEFAULT_PERMISSIONS[configurable];
}

// Va después de la revalidación del usuario y del límite de choferes. Las
// cuentas de chofer ya están limitadas a su hoja de ruta: no pasan por acá.
export function enforceModules(pool) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || isAdmin(role) || req.driverId) return next();
    const rule = ruleFor(req.method, req.path);
    if (!rule || rule.modules === OPEN) return next();
    if (rule.modules === ADMIN_ONLY) {
      return res.status(403).json({ status: 403, message: "Solo el administrador puede hacer esto." });
    }
    modulesForRole(pool, req.tenantId, role)
      .then((modules) => {
        req.modules = modules;
        if (rule.modules.some((m) => modules.includes(m))) return next();
        const label = MODULES.find((m) => m.id === rule.modules[0])?.label ?? rule.modules[0];
        return res.status(403).json({ status: 403, message: `Tu rol no tiene acceso a ${label}. Pedíselo al administrador.` });
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ status: 500, message: "Unexpected error" });
      });
  };
}

const saveSchema = z.object({ modules: z.array(z.string()).max(50) }).strict();

export function registerPermissionsRoutes(app, pool, requireRole) {
  // Los propios permisos los lee cualquiera con sesión: el panel arma el menú.
  app.get("/me/permissions", async (req, res) => {
    try {
      const role = req.user?.role;
      const driver = Boolean(req.driverId);
      res.json({
        role,
        role_label: ROLE_LABELS[role] ?? role,
        is_admin: isAdmin(role),
        driver,
        modules: driver ? [] : await modulesForRole(pool, req.tenantId, role),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 500, message: "No se pudieron leer los permisos" });
    }
  });

  app.get("/v2/permissions", requireRole("admin"), async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    try {
      res.json({
        modules: MODULES,
        roles: CONFIGURABLE_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] })),
        defaults: DEFAULT_PERMISSIONS,
        permissions: await loadPermissions(pool, req.tenantId),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 500, message: "No se pudieron leer los permisos" });
    }
  });

  // Reemplaza todos los módulos de un rol de una vez: la pantalla manda la
  // fila entera, así no puede quedar a medio guardar.
  app.put("/v2/permissions/:role", requireRole("admin"), async (req, res) => {
    if (!req.tenantId) return res.status(403).json({ status: 403, message: "No tenant context" });
    const { role } = req.params;
    const parsed = saveSchema.safeParse(req.body);
    if (!CONFIGURABLE_ROLES.includes(role)) return res.status(400).json({ status: 400, message: "Rol inválido" });
    if (!parsed.success || parsed.data.modules.some((m) => !MODULE_IDS.includes(m))) {
      return res.status(400).json({ status: 400, message: "Módulos inválidos" });
    }
    const modules = MODULE_IDS.filter((m) => parsed.data.modules.includes(m));
    try {
      await pool.query(
        `INSERT INTO tenant_role_permissions (tenant_id, role, modules, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, role) DO UPDATE
           SET modules = EXCLUDED.modules, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.tenantId, role, modules, req.user?.sub ?? null]
      );
      res.json({ role, modules });
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 500, message: "No se pudieron guardar los permisos" });
    }
  });
}
