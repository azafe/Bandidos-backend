// tests/helpers/authRevalidation.js
//
// El middleware de auth (src/index.js, justo después de requireAuth) ahora
// revalida rol y tenant_id contra la base en cada request en vez de confiar
// ciegamente en lo que dice el JWT, con esta consulta:
//
//   SELECT u.role, u.tenant_id, t.status AS tenant_status, t.suspended_reason
//   FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1
//
// Los tests de este repo firman tokens con un `sub` al voleo y mockean
// pool.query a mano; este helper registra qué rol/tenant le corresponde a
// cada sub en el momento de firmar el token, y arma la respuesta que esa
// query espera -para que cualquier mock de pool.query pueda delegarle esa
// única consulta sin reimplementar el join.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const usersById = new Map();

export function registerUser({ role, tenant_id = null, status = "active", suspended_reason = null }) {
  const id = crypto.randomUUID();
  usersById.set(id, { role, tenant_id, status, suspended_reason });
  return id;
}

// Simula un cambio hecho por afuera (un admin le cambia el rol a alguien, lo
// da de baja, o se suspende el tenant) mientras un token viejo sigue vivo.
export function updateUser(sub, patch) {
  const current = usersById.get(sub);
  if (!current) throw new Error(`updateUser: no hay un usuario registrado para ${sub}`);
  usersById.set(sub, { ...current, ...patch });
}

// Simula que el usuario del token fue borrado de la base.
export function removeUser(sub) {
  usersById.delete(sub);
}

export function signTokenFor({
  role,
  tenant_id = null,
  email,
  status = "active",
  suspended_reason = null,
  secret = process.env.JWT_SECRET
}) {
  const sub = registerUser({ role, tenant_id, status, suspended_reason });
  const token = jwt.sign({ sub, role, email: email || `${role}@test.com`, tenant_id }, secret);
  return { token, sub };
}

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

// Devuelve el resultado mockeado si `sql` es la query de revalidación de
// auth, o null si no la reconoce (el caller sigue con su propio switch).
export function handleAuthRevalidation(sql, params) {
  const q = norm(sql);
  if (!q.startsWith("select u.role, u.tenant_id")) return null;
  const user = usersById.get(params[0]);
  if (!user) return { rowCount: 0, rows: [] };
  return {
    rowCount: 1,
    rows: [{
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_status: user.status,
      suspended_reason: user.suspended_reason
    }]
  };
}
