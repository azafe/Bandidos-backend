import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { pool } from "./db.js";
import { createEmailClient } from "./email.js";
import {
  createPasswordResetService,
  forgotPasswordSchema,
  PasswordResetError,
  resetPasswordSchema
} from "./auth/passwordResetService.js";
import { createPasswordResetStore } from "./auth/passwordResetStore.js";

const app = express();

const corsOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const statusSchema = z.enum(["active", "inactive"]);
const agendaStatusSchema = z.enum(["reserved", "finished", "cancelled"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  password_hash: z.string().min(1).optional(),
  role: z.string().min(1)
}).refine((data) => data.password || data.password_hash, {
  message: "password or password_hash is required"
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  password_hash: z.string().min(1).optional(),
  role: z.string().min(1).optional()
});

const emptyStringToNull = (value) => {
  if (value === "") {
    return null;
  }
  return value;
};

const createEmployeeSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  email: z.preprocess(emptyStringToNull, z.string().email().nullable().optional()),
  status: statusSchema,
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const updateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  email: z.preprocess(emptyStringToNull, z.string().email().nullable().optional()),
  status: statusSchema.optional(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  email: z.preprocess(emptyStringToNull, z.string().email().nullable().optional()),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  email: z.preprocess(emptyStringToNull, z.string().email().nullable().optional()),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const createPetSchema = z.object({
  name: z.string().min(1),
  breed: z.string().min(1).optional().nullable(),
  owner_name: z.string().min(1),
  owner_phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  neutered: z.boolean().optional().default(false),
  behavior: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  size: z.string().min(1).optional().nullable(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  age: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  address: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  birth_date: z.preprocess(emptyStringToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
});

const updatePetSchema = z.object({
  name: z.string().min(1).optional(),
  breed: z.string().min(1).optional().nullable(),
  owner_name: z.string().min(1).optional(),
  owner_phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  neutered: z.boolean().optional(),
  behavior: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  size: z.string().min(1).optional().nullable(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  age: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  address: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  birth_date: z.preprocess(emptyStringToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
});

const createAgendaSchema = z.object({
  date: dateSchema,
  time: timeSchema,
  duration: z.coerce.number().int().min(1).optional().default(60),
  pet_id: z.string().uuid().optional().nullable(),
  pet_name: z.string().min(1),
  breed: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  owner_name: z.string().min(1),
  service_type_id: z.string().uuid().optional().nullable(),
  payment_method_id: z.string().uuid().optional().nullable(),
  price: z.coerce.number().min(0).optional().nullable(),
  deposit_amount: z.coerce.number().min(0).optional().default(0),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  groomer_id: z.string().uuid().optional().nullable(),
  status: agendaStatusSchema.optional().default("reserved")
});

const updateAgendaSchema = z.object({
  date: dateSchema.optional(),
  time: timeSchema.optional(),
  duration: z.coerce.number().int().min(1).optional(),
  pet_id: z.string().uuid().optional().nullable(),
  pet_name: z.string().min(1).optional(),
  breed: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  owner_name: z.string().min(1).optional(),
  service_type_id: z.string().uuid().optional(),
  payment_method_id: z.string().uuid().optional().nullable(),
  price: z.coerce.number().min(0).optional().nullable(),
  deposit_amount: z.coerce.number().min(0).optional(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  groomer_id: z.string().uuid().optional().nullable(),
  status: agendaStatusSchema.optional()
});

const createPetshopProductSchema = z.object({
  name: z.string().min(1),
  sku: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  category: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  supplier_id: z.string().uuid().optional().nullable(),
  cost: z.coerce.number().min(0).optional().default(0),
  price: z.coerce.number().min(0),
  stock: z.coerce.number().int().min(0).optional().default(0),
  stock_min: z.coerce.number().int().min(0).optional().default(0)
});

const updatePetshopProductSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  category: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  supplier_id: z.string().uuid().optional().nullable(),
  cost: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  stock: z.coerce.number().int().min(0).optional(),
  stock_min: z.coerce.number().int().min(0).optional()
});

const createPetshopSaleSchema = z.object({
  date: dateSchema,
  customer_id: z.string().uuid().optional().nullable(),
  payment_method_id: z.string().uuid(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  total: z.coerce.number().min(0),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.coerce.number().int().min(1),
        unit_price: z.coerce.number().min(0)
      })
    )
    .min(1)
});

const stockMovementTypeSchema = z.enum(["in", "out", "adjust"]);

const createPetshopStockMovementSchema = z.object({
  date: dateSchema,
  product_id: z.string().uuid(),
  type: stockMovementTypeSchema,
  quantity: z.coerce.number().int().min(0),
  note: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
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

const jwtSecret = process.env.JWT_SECRET || "";
const passwordResetTokenTtlMinutesRaw = Number(
  process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 60
);
const passwordResetTokenTtlMinutes = Number.isFinite(passwordResetTokenTtlMinutesRaw)
  ? passwordResetTokenTtlMinutesRaw
  : 60;
const passwordResetUrlBase =
  process.env.PASSWORD_RESET_URL_BASE || "https://miapp.com/reset-password";

const emailClient = createEmailClient();
const passwordResetService = createPasswordResetService({
  store: createPasswordResetStore(pool),
  sendResetEmail: emailClient.sendPasswordResetEmail,
  tokenTtlMs: passwordResetTokenTtlMinutes * 60 * 1000,
  resetUrlBase: passwordResetUrlBase
});

const createRateLimiter = ({ windowMs, max }) => {
  const hits = new Map();

  const prune = (timestamps, now) => {
    while (timestamps.length && now - timestamps[0] > windowMs) {
      timestamps.shift();
    }
  };

  return {
    consume(key) {
      const now = Date.now();
      const timestamps = hits.get(key) ?? [];
      prune(timestamps, now);
      if (timestamps.length >= max) {
        hits.set(key, timestamps);
        return false;
      }
      timestamps.push(now);
      hits.set(key, timestamps);
      return true;
    }
  };
};

const forgotPasswordIpLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const forgotPasswordEmailLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5
});
const resetPasswordIpLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
const resetPasswordTokenLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10
});

const signToken = (user) => {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, tenant_id: user.tenant_id ?? null },
    jwtSecret,
    { expiresIn: "7d" }
  );
};

const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (!jwtSecret) {
    return sendError(res, 500, "JWT_SECRET is not configured");
  }

  if (scheme !== "Bearer" || !token) {
    return sendError(res, 401, "Unauthorized");
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    return next();
  } catch (err) {
    console.error(err);
    return sendError(res, 401, "Unauthorized");
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, "Unauthorized");
    if (req.user.role === "super_admin") return next();
    if (!roles.includes(req.user.role)) return sendError(res, 403, "Forbidden");
    return next();
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "super_admin") {
    return sendError(res, 403, "Forbidden");
  }
  return next();
};

const hashPassword = async (password) => {
  return bcrypt.hash(password, 10);
};

const verifyPassword = async (password, passwordHash) => {
  return bcrypt.compare(password, passwordHash);
};

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
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

app.post("/auth/register", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  if (!jwtSecret) {
    return sendError(res, 500, "JWT_SECRET is not configured");
  }

  const { email, password } = parsed.data;

  try {
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, created_at`,
      [email, passwordHash, "user"]
    );

    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === "23505") {
      return sendError(res, 409, "Email already exists");
    }
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/auth/login", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  if (!jwtSecret) {
    return sendError(res, 500, "JWT_SECRET is not configured");
  }

  const { email, password } = parsed.data;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rowCount === 0) {
      return sendError(res, 401, "Invalid credentials");
    }

    const user = result.rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return sendError(res, 401, "Invalid credentials");
    }

    // Verificar que el tenant esté activo (no aplica a super_admin sin tenant)
    if (user.tenant_id) {
      const tenantResult = await pool.query(
        "SELECT status FROM tenants WHERE id = $1",
        [user.tenant_id]
      );
      if (!tenantResult.rows.length || tenantResult.rows[0].status !== "active") {
        return sendError(res, 403, "Tenant is inactive");
      }
    }

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id ?? null,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/auth/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const email = parsed.data.email.toLowerCase();
  const ip = getClientIp(req);
  const userAgent = req.get("user-agent") || "";

  if (!forgotPasswordIpLimiter.consume(ip) || !forgotPasswordEmailLimiter.consume(email)) {
    return sendError(res, 429, "Too many requests");
  }

  try {
    await passwordResetService.requestReset(email, { ip, userAgent });
  } catch (err) {
    console.error(err);
  }

  res.json({ ok: true });
});

app.post("/auth/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { token, newPassword } = parsed.data;
  const ip = getClientIp(req);
  const userAgent = req.get("user-agent") || "";

  if (!resetPasswordIpLimiter.consume(ip) || !resetPasswordTokenLimiter.consume(token)) {
    return sendError(res, 429, "Too many requests");
  }

  try {
    await passwordResetService.resetPassword(token, newPassword, { ip, userAgent });
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof PasswordResetError && err.code === "weak_password") {
      return sendError(res, 400, "Password does not meet requirements");
    }
    if (err instanceof PasswordResetError) {
      return sendError(res, 400, "Invalid or expired token");
    }
    console.error(err);
    return sendError(res, 500, "Unexpected error");
  }
});

app.use(requireAuth);

// Extrae tenant_id del JWT y lo pone en req.tenantId.
// También bloquea tenants inactivos y super_admin en rutas de datos.
app.use((req, res, next) => {
  req.tenantId = req.user?.tenant_id ?? null;

  // Si es super_admin y NO está en una ruta de superadmin (/v2/super/...),
  // ni en /me o /health, bloqueamos el acceso.
  if (req.user?.role === "super_admin") {
    const path = req.path;
    const isSuperRoute = path.startsWith("/v2/super/");
    const isPublic = path === "/me" || path === "/health" || path === "/auth/logout";
    if (!isSuperRoute && !isPublic) {
      return sendError(res, 403, "Super Admin cannot access tenant data routes");
    }
    return next();
  }

  // Verificar que el tenant del usuario esté activo.
  // Consultamos la DB solo si el usuario tiene tenant_id.
  if (req.tenantId) {
    pool.query("SELECT status FROM tenants WHERE id = $1", [req.tenantId])
      .then(({ rows }) => {
        if (!rows.length || rows[0].status !== "active") {
          return sendError(res, 403, "Tenant is inactive");
        }
        next();
      })
      .catch(() => sendError(res, 500, "Unexpected error"));
  } else {
    next();
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.tenant_id, u.created_at,
              t.name as tenant_name, t.logo_url as tenant_logo, 
              t.primary_color, t.secondary_color, t.enabled_modules
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.user.sub]
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

app.get("/reports/summary", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const includeFixedRaw =
    typeof req.query.include_fixed === "string" ? req.query.include_fixed.trim() : "";
  const includeFixed = includeFixedRaw ? includeFixedRaw !== "false" : true;
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`date <= $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const fixedFilters = [];
  const fixedParams = [];
  if (req.tenantId) { fixedParams.push(req.tenantId); fixedFilters.push(`tenant_id = $${fixedParams.length}`); }
  fixedFilters.push("status = 'active'");
  const fixedWhere = `WHERE ${fixedFilters.join(" AND ")}`;

  try {
    const servicesResult = await pool.query(
      `SELECT COALESCE(SUM(price), 0) AS total
       FROM services ${whereClause}`,
      params
    );
    const dailyResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM daily_expenses ${whereClause}`,
      params
    );
    const fixedResult = includeFixed
      ? await pool.query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM fixed_expenses ${fixedWhere}`,
          fixedParams
        )
      : { rows: [{ total: 0 }] };

    const servicesTotal = Number(servicesResult.rows[0]?.total ?? 0);
    const dailyTotal = Number(dailyResult.rows[0]?.total ?? 0);
    const fixedTotal = Number(fixedResult.rows[0]?.total ?? 0);

    res.json({
      services_total: servicesTotal,
      daily_expenses_total: dailyTotal,
      fixed_expenses_total: fixedTotal,
      net_total: servicesTotal - dailyTotal - fixedTotal
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/reports/daily", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`date <= $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const result = await pool.query(
      `SELECT
         COALESCE(s.date, d.date) AS date,
         COALESCE(s.services_total, 0) AS services_total,
         COALESCE(d.daily_expenses_total, 0) AS daily_expenses_total,
         COALESCE(s.services_total, 0) - COALESCE(d.daily_expenses_total, 0) AS net_total
       FROM (
         SELECT date, SUM(price) AS services_total
         FROM services
         ${whereClause}
         GROUP BY date
       ) s
       FULL OUTER JOIN (
         SELECT date, SUM(amount) AS daily_expenses_total
         FROM daily_expenses
         ${whereClause}
         GROUP BY date
       ) d ON s.date = d.date
       ORDER BY date DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/reports/by-groomer", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`s.tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`s.date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`s.date <= $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const result = await pool.query(
      `SELECT
         e.id AS groomer_id,
         e.name AS groomer_name,
         COUNT(s.id) AS services_count,
         COALESCE(SUM(s.price), 0) AS total
       FROM services s
       LEFT JOIN employees e ON s.groomer_id = e.id
       ${whereClause}
       GROUP BY e.id, e.name
       ORDER BY total DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/reports/by-customer", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`s.tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`s.date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`s.date <= $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const result = await pool.query(
      `SELECT
         c.id AS customer_id,
         c.name AS customer_name,
         COUNT(s.id) AS services_count,
         COALESCE(SUM(s.price), 0) AS total
       FROM services s
       JOIN customers c ON s.customer_id = c.id
       ${whereClause}
       GROUP BY c.id, c.name
       ORDER BY total DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/services", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const customerId =
    typeof req.query.customer_id === "string" ? req.query.customer_id.trim() : "";
  const petId = typeof req.query.pet_id === "string" ? req.query.pet_id.trim() : "";
  const serviceTypeId =
    typeof req.query.service_type_id === "string"
      ? req.query.service_type_id.trim()
      : "";
  const groomerId =
    typeof req.query.groomer_id === "string" ? req.query.groomer_id.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`date <= $${params.length}`);
  }

  if (customerId) {
    params.push(customerId);
    filters.push(`customer_id = $${params.length}`);
  }

  if (petId) {
    params.push(petId);
    filters.push(`pet_id = $${params.length}`);
  }

  if (serviceTypeId) {
    params.push(serviceTypeId);
    filters.push(`service_type_id = $${params.length}`);
  }

  if (groomerId) {
    params.push(groomerId);
    filters.push(`groomer_id = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM services ${whereClause} ORDER BY date DESC, created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/services", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
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
        (date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        date,
        pet_id,
        customer_id,
        service_type_id,
        price,
        payment_method_id,
        groomer_id ?? null,
        notes ?? null,
        req.tenantId
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/services/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
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
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;

  try {
    const result = await pool.query(
      `UPDATE services SET ${fields.join(", ")}
       WHERE id = $${idx}${tenantClause}
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
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `DELETE FROM services WHERE id = $1${tenantClause}`,
      params
    );

    if (result.rowCount === 0) {
      return sendError(res, 404, "Service not found");
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/users", requireAuth, requireRole("admin"), async (req, res) => {
  const params = [];
  const tenantClause = req.tenantId ? `WHERE tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT id, email, role, tenant_id, created_at FROM users ${tenantClause} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT id, email, role, tenant_id, created_at FROM users WHERE id = $1${tenantClause}`,
      params
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

app.post("/v2/users", requireAuth, requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { email, password, password_hash, role } = parsed.data;
  const passwordHash = password ? await hashPassword(password) : password_hash;

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, tenant_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, tenant_id, created_at`,
      [email, passwordHash, role, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const updates = parsed.data;
  if (updates.password) {
    updates.password_hash = await hashPassword(updates.password);
    delete updates.password;
  }
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
       RETURNING id, email, role, created_at`,
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

app.delete("/v2/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, "User not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/employees", async (req, res) => {
  const params = [];
  const tenantClause = req.tenantId ? `WHERE tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM employees ${tenantClause} ORDER BY created_at DESC`, params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/employees/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM employees WHERE id = $1${tenantClause}`, params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Employee not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/employees", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { name, role, phone, email, status, notes } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO employees (name, role, phone, email, status, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, role, phone ?? null, email ?? null, status, notes ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/employees/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(["name", "role", "phone", "email", "status", "notes"], updates);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");

  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE employees SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Employee not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/employees/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM employees WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Employee not found");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/customers", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }
  if (query) {
    params.push(`%${query}%`);
    filters.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM customers ${whereClause} ORDER BY created_at DESC`, params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/customers/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM customers WHERE id = $1${tenantClause}`, params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Customer not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/customers", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { name, phone, email, notes } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO customers (name, phone, email, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, phone ?? null, email ?? null, notes ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/customers/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(["name", "phone", "email", "notes"], updates);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");

  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE customers SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Customer not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/customers/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM customers WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Customer not found");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/pets", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }
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
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM pets WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/pets", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createPetSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { name, breed, owner_name, owner_phone, neutered, behavior, size, notes, age, address, birth_date } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO pets (name, breed, owner_name, owner_phone, neutered, behavior, size, notes, age, address, birth_date, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [name, breed ?? null, owner_name, owner_phone ?? null, neutered, behavior ?? null, size ?? null, notes ?? null, age ?? null, address ?? null, birth_date ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/pets/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updatePetSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["name", "breed", "owner_name", "owner_phone", "neutered", "behavior", "size", "notes", "age", "address", "birth_date"],
    updates
  );

  if (fields.length === 0) return sendError(res, 400, "No fields to update");

  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE pets SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/v2/pets/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM pets WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/agenda", async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

  if (from || to) {
    const parsedFrom = dateSchema.safeParse(from);
    const parsedTo = dateSchema.safeParse(to);
    if (!parsedFrom.success || !parsedTo.success) {
      return sendError(res, 400, "Invalid date range");
    }

    const rangeParams = [parsedFrom.data, parsedTo.data];
    const tenantRange = req.tenantId ? ` AND tenant_id = $${rangeParams.push(req.tenantId)}` : "";
    try {
      const result = await pool.query(
        `SELECT * FROM agenda_turnos WHERE date BETWEEN $1 AND $2${tenantRange} ORDER BY date ASC, time ASC`,
        rangeParams
      );
      return res.json(result.rows);
    } catch (err) {
      console.error(err);
      return sendError(res, 500, "Unexpected error");
    }
  }

  const parsedDate = dateSchema.safeParse(date);
  if (!parsedDate.success) return sendError(res, 400, "Invalid date");

  const dayParams = [parsedDate.data];
  const tenantDay = req.tenantId ? ` AND tenant_id = $${dayParams.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM agenda_turnos WHERE date = $1${tenantDay} ORDER BY time ASC`,
      dayParams
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/agenda/summary", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const parsedFrom = dateSchema.safeParse(from);
  const parsedTo = dateSchema.safeParse(to);

  if (!parsedFrom.success || !parsedTo.success) return sendError(res, 400, "Invalid date range");

  const params = [parsedFrom.data, parsedTo.data];
  const tenantClause = req.tenantId ? ` AND a.tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(st.default_price), 0) AS total_estimated,
         COALESCE(SUM(a.deposit_amount), 0) AS total_deposit
       FROM agenda_turnos a
       LEFT JOIN service_types st ON st.id = a.service_type_id
       WHERE a.date BETWEEN $1 AND $2${tenantClause}`,
      params
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/agenda", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createAgendaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 400, message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
  }

  const {
    date,
    time,
    duration,
    pet_id,
    pet_name,
    breed,
    owner_name,
    service_type_id,
    payment_method_id,
    price,
    deposit_amount,
    notes,
    groomer_id,
    status
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO agenda_turnos
       (date, time, duration, pet_id, pet_name, breed, owner_name, service_type_id,
        payment_method_id, price, deposit_amount, notes, groomer_id, status, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        date, time, duration, pet_id ?? null, pet_name, breed ?? null, owner_name,
        service_type_id, payment_method_id ?? null, price ?? null, deposit_amount ?? 0,
        notes ?? null, groomer_id ?? null, status, req.tenantId
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/agenda/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateAgendaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 400, message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
  }

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    [
      "date",
      "time",
      "duration",
      "pet_id",
      "pet_name",
      "breed",
      "owner_name",
      "service_type_id",
      "payment_method_id",
      "price",
      "deposit_amount",
      "notes",
      "groomer_id",
      "status"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  try {
    if (updates.date || updates.time) {
      const current = await pool.query(
        "SELECT date, time FROM agenda_turnos WHERE id = $1",
        [req.params.id]
      );
      if (current.rowCount === 0) {
        return sendError(res, 404, "Agenda item not found");
      }

    }

    values.push(req.params.id);
    const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;

    const result = await pool.query(
      `UPDATE agenda_turnos SET ${fields.join(", ")}
       WHERE id = $${idx}${tenantClause}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) return sendError(res, 404, "Agenda item not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.delete("/agenda/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `DELETE FROM agenda_turnos WHERE id = $1${tenantClause}`, params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Agenda item not found");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/service-types", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];
  const params = [];
  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }
  if (query) { params.push(`%${query}%`); filters.push(`name ILIKE $${params.length}`); }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  try {
    const result = await pool.query(`SELECT * FROM service_types ${whereClause} ORDER BY created_at DESC`, params);
    res.json(result.rows);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/service-types/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM service_types WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Service type not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/service-types", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createServiceTypeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { name, default_price } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO service_types (name, default_price, tenant_id) VALUES ($1, $2, $3) RETURNING *`,
      [name, default_price ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/service-types/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateServiceTypeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(["name", "default_price"], parsed.data);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE service_types SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Service type not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/service-types/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM service_types WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Service type not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/payment-methods", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];
  const params = [];
  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }
  if (query) { params.push(`%${query}%`); filters.push(`name ILIKE $${params.length}`); }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  try {
    const result = await pool.query(`SELECT * FROM payment_methods ${whereClause} ORDER BY created_at DESC`, params);
    res.json(result.rows);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/payment-methods/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM payment_methods WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Payment method not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/payment-methods", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createPaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { name } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO payment_methods (name, tenant_id) VALUES ($1, $2) RETURNING *`,
      [name, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/payment-methods/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updatePaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(["name"], parsed.data);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE payment_methods SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Payment method not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/payment-methods/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM payment_methods WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Payment method not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/petshop/products", async (req, res) => {
  const params = [];
  const tenantClause = req.tenantId ? `WHERE tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM petshop_products ${tenantClause} ORDER BY created_at DESC`, params);
    res.json(result.rows);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/petshop/products", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createPetshopProductSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { name, sku, category, supplier_id, cost, price, stock, stock_min } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO petshop_products (name, sku, category, supplier_id, cost, price, stock, stock_min, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, sku ?? null, category ?? null, supplier_id ?? null, cost ?? 0, price, stock ?? 0, stock_min ?? 0, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/petshop/products/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updatePetshopProductSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(
    ["name", "sku", "category", "supplier_id", "cost", "price", "stock", "stock_min"], parsed.data
  );
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  const updateFields = [...fields, "updated_at = now()"];
  try {
    const result = await pool.query(
      `UPDATE petshop_products SET ${updateFields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Product not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/petshop/products/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM petshop_products WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Product not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/petshop/sales", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const parsedFrom = dateSchema.safeParse(from);
  const parsedTo = dateSchema.safeParse(to);

  if (!parsedFrom.success || !parsedTo.success) {
    return sendError(res, 400, "Invalid date range");
  }

  try {
    const result = await pool.query(
      `SELECT
         s.*,
         COALESCE(
           json_agg(
             json_build_object(
               'id', si.id,
               'product_id', si.product_id,
               'quantity', si.quantity,
               'unit_price', si.unit_price
             )
             ORDER BY si.id
           ) FILTER (WHERE si.id IS NOT NULL),
           '[]'
         ) AS items
       FROM petshop_sales s
       LEFT JOIN petshop_sale_items si ON si.sale_id = s.id
       WHERE s.date BETWEEN $1 AND $2${req.tenantId ? ` AND s.tenant_id = $3` : ""}
       GROUP BY s.id
       ORDER BY s.date DESC, s.created_at DESC`,
      req.tenantId ? [parsedFrom.data, parsedTo.data, req.tenantId] : [parsedFrom.data, parsedTo.data]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/petshop/sales", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createPetshopSaleSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { date, customer_id, payment_method_id, notes, total, items } = parsed.data;
  const productIds = [...new Set(items.map((item) => item.product_id))];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const products = await client.query(
      "SELECT id, stock FROM petshop_products WHERE id = ANY($1::uuid[]) FOR UPDATE",
      [productIds]
    );

    if (products.rowCount !== productIds.length) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Invalid product_id");
    }

    const saleResult = await client.query(
      `INSERT INTO petshop_sales
       (date, customer_id, payment_method_id, notes, total, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [date, customer_id ?? null, payment_method_id, notes ?? null, total, req.tenantId]
    );
    const sale = saleResult.rows[0];
    const saleItems = [];

    for (const item of items) {
      const itemResult = await client.query(
        `INSERT INTO petshop_sale_items
         (sale_id, product_id, quantity, unit_price, tenant_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [sale.id, item.product_id, item.quantity, item.unit_price, req.tenantId]
      );
      saleItems.push(itemResult.rows[0]);

      await client.query(
        `UPDATE petshop_products
         SET stock = stock - $1,
             updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [item.quantity, item.product_id, req.tenantId]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ ...sale, items: saleItems });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

app.get("/v2/petshop/stock-movements", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const parsedFrom = dateSchema.safeParse(from);
  const parsedTo = dateSchema.safeParse(to);

  if (!parsedFrom.success || !parsedTo.success) {
    return sendError(res, 400, "Invalid date range");
  }

  try {
    const result = await pool.query(
      `SELECT *
       FROM petshop_stock_movements
       WHERE date BETWEEN $1 AND $2${req.tenantId ? ` AND tenant_id = $3` : ""}
       ORDER BY date DESC, created_at DESC`,
      req.tenantId ? [parsedFrom.data, parsedTo.data, req.tenantId] : [parsedFrom.data, parsedTo.data]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/petshop/stock-movements", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createPetshopStockMovementSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  const { date, product_id, type, quantity, note } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      "SELECT * FROM petshop_products WHERE id = $1 FOR UPDATE",
      [product_id]
    );
    if (productResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Invalid product_id");
    }

    const product = productResult.rows[0];
    let newStock = product.stock;
    if (type === "in") {
      newStock += quantity;
    } else if (type === "out") {
      newStock -= quantity;
    } else {
      newStock = quantity;
    }

    const updateResult = await client.query(
      `UPDATE petshop_products
       SET stock = $1,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [newStock, product_id]
    );

    const movementResult = await client.query(
      `INSERT INTO petshop_stock_movements
       (date, product_id, type, quantity, note, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [date, product_id, type, quantity, note ?? null, req.tenantId]
    );

    await client.query("COMMIT");
    res.status(201).json({
      movement: movementResult.rows[0],
      product: updateResult.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

app.get("/v2/services", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const customerId =
    typeof req.query.customer_id === "string" ? req.query.customer_id.trim() : "";
  const petId = typeof req.query.pet_id === "string" ? req.query.pet_id.trim() : "";
  const serviceTypeId =
    typeof req.query.service_type_id === "string"
      ? req.query.service_type_id.trim()
      : "";
  const groomerId =
    typeof req.query.groomer_id === "string" ? req.query.groomer_id.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }

  if (from) {
    params.push(from);
    filters.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    filters.push(`date <= $${params.length}`);
  }

  if (customerId) {
    params.push(customerId);
    filters.push(`customer_id = $${params.length}`);
  }

  if (petId) {
    params.push(petId);
    filters.push(`pet_id = $${params.length}`);
  }

  if (serviceTypeId) {
    params.push(serviceTypeId);
    filters.push(`service_type_id = $${params.length}`);
  }

  if (groomerId) {
    params.push(groomerId);
    filters.push(`groomer_id = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT * FROM services ${whereClause} ORDER BY date DESC, created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/services/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM services WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Service not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/services", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id, notes } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO services (date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [date, pet_id, customer_id, service_type_id, price, payment_method_id, groomer_id ?? null, notes ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/services/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateServiceRecordSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { fields, values, idx } = buildUpdate(
    ["date", "pet_id", "customer_id", "service_type_id", "price", "payment_method_id", "groomer_id", "notes"],
    parsed.data
  );
  if (fields.length === 0) return sendError(res, 400, "No fields to update");

  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE services SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Service not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/services/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM services WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Service not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/suppliers", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`suppliers.tenant_id = $${params.length}`); }

  if (query) {
    params.push(`%${query}%`);
    filters.push(`name ILIKE $${params.length}`);
  }

  if (category) {
    params.push(category);
    filters.push(`category = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT suppliers.*,
    payment_methods.name AS payment_method_name
    FROM suppliers
    LEFT JOIN payment_methods
      ON payment_methods.id = suppliers.payment_method_id
    ${whereClause}
    ORDER BY suppliers.created_at DESC`;

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/suppliers/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND suppliers.tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT suppliers.*, payment_methods.name AS payment_method_name
       FROM suppliers LEFT JOIN payment_methods ON payment_methods.id = suppliers.payment_method_id
       WHERE suppliers.id = $1${tenantClause}`,
      params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Supplier not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/suppliers", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createSupplierSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { name, category, phone, payment_method_id, notes } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO suppliers (name, category, phone, payment_method_id, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, category ?? null, phone ?? null, payment_method_id ?? null, notes ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/suppliers/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateSupplierSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(["name", "category", "phone", "payment_method_id", "notes"], parsed.data);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE suppliers SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Supplier not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/suppliers/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM suppliers WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Supplier not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/expense-categories", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filters = [];
  const params = [];
  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }
  if (query) { params.push(`%${query}%`); filters.push(`name ILIKE $${params.length}`); }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  try {
    const result = await pool.query(`SELECT * FROM expense_categories ${whereClause} ORDER BY created_at DESC`, params);
    res.json(result.rows);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/expense-categories/:id", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM expense_categories WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Expense category not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/expense-categories", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createExpenseCategorySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { name } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO expense_categories (name, tenant_id) VALUES ($1, $2) RETURNING *`,
      [name, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/expense-categories/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateExpenseCategorySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(["name"], parsed.data);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE expense_categories SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Expense category not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/expense-categories/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM expense_categories WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Expense category not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/daily-expenses", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const categoryId =
    typeof req.query.category_id === "string" ? req.query.category_id.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`tenant_id = $${params.length}`); }

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
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(`SELECT * FROM daily_expenses WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Daily expense not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/daily-expenses", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createDailyExpenseSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { date, category_id, description, amount, payment_method_id, supplier_id } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO daily_expenses (date, category_id, description, amount, payment_method_id, supplier_id, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [date, category_id, description, amount, payment_method_id, supplier_id ?? null, req.tenantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/daily-expenses/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateDailyExpenseSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { fields, values, idx } = buildUpdate(
    ["date", "category_id", "description", "amount", "payment_method_id", "supplier_id"], parsed.data
  );
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE daily_expenses SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`, values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Daily expense not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/daily-expenses/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM daily_expenses WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Daily expense not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.get("/v2/fixed-expenses", async (req, res) => {
  const categoryId =
    typeof req.query.category_id === "string" ? req.query.category_id.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const filters = [];
  const params = [];

  if (req.tenantId) {
    params.push(req.tenantId);
    filters.push(`tenant_id = $${params.length}`);
  }

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
    const tenantClause = req.tenantId ? ` AND tenant_id = $2` : "";
    const params = req.tenantId ? [req.params.id, req.tenantId] : [req.params.id];
    const result = await pool.query(
      `SELECT * FROM fixed_expenses WHERE id = $1${tenantClause}`,
      params
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

app.post("/v2/fixed-expenses", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

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
        (name, category_id, amount, due_day, payment_method_id, supplier_id, status, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        category_id,
        amount,
        due_day,
        payment_method_id,
        supplier_id ?? null,
        status,
        req.tenantId
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/fixed-expenses/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

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
  const tenantClause = req.tenantId ? ` AND tenant_id = $${values.push(req.tenantId)}` : "";

  try {
    const result = await pool.query(
      `UPDATE fixed_expenses SET ${fields.join(", ")}
       WHERE id = $${idx}${tenantClause}
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
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

  try {
    const tenantClause = ` AND tenant_id = $2`;
    const result = await pool.query(
      `DELETE FROM fixed_expenses WHERE id = $1${tenantClause}`,
      [req.params.id, req.tenantId]
    );
    if (result.rowCount === 0) {
      return sendError(res, 404, "Fixed expense not found");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

// ─── Super Admin: gestión de tenants ────────────────────────────────────────

app.get("/v2/super/tenants", requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, COUNT(u.id)::int AS user_count
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/super/tenants/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, COUNT(u.id)::int AS user_count
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [req.params.id]
    );
    if (result.rowCount === 0) return sendError(res, 404, "Tenant not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/super/tenants", requireAuth, requireSuperAdmin, async (req, res) => {
  const schema = z.object({
    name:            z.string().min(1),
    logo_url:        z.string().url().optional().nullable(),
    primary_color:   z.string().optional().nullable(),
    secondary_color: z.string().optional().nullable(),
    plan:            z.string().optional().default("basic"),
    enabled_modules: z.record(z.boolean()).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { name, logo_url, primary_color, secondary_color, plan, enabled_modules } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO tenants (name, logo_url, primary_color, secondary_color, plan, enabled_modules)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name, 
        logo_url ?? null, 
        primary_color ?? null, 
        secondary_color ?? null, 
        plan, 
        enabled_modules ? JSON.stringify(enabled_modules) : undefined
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.patch("/v2/super/tenants/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  const allowed = ["name", "logo_url", "primary_color", "secondary_color", "plan", "status", "enabled_modules"];
  const { fields, values, idx } = buildUpdate(allowed, req.body);
  if (fields.length === 0) return sendError(res, 400, "No fields to update");
  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE tenants SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Tenant not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/super/tenants/:id/admin", requireAuth, requireSuperAdmin, async (req, res) => {
  const schema = z.object({
    email:    z.string().email(),
    password: z.string().min(6)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  // Verificar que el tenant existe
  const tenantResult = await pool.query("SELECT id FROM tenants WHERE id = $1", [req.params.id]);
  if (tenantResult.rowCount === 0) return sendError(res, 404, "Tenant not found");

  const { email, password } = parsed.data;
  const passwordHash = await hashPassword(password);

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, tenant_id)
       VALUES ($1, $2, 'admin', $3)
       RETURNING id, email, role, tenant_id, created_at`,
      [email, passwordHash, req.params.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return sendError(res, 409, "Email already exists");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

// ────────────────────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  sendError(res, 500, "Unexpected error");
});

const port = process.env.PORT || 3000;

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`API running on :${port}`);
  });
}
