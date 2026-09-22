import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import {
  endOfCurrentMonth,
  dueDateSql,
  periodSchema,
  periodToDate,
  previousPeriodDate,
  toDateKey,
  buildAccrual
} from "./fixedExpenses.js";
import jwt from "jsonwebtoken";
import webpush from "web-push";
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
import { uploadPhoto } from "./storage.js";

const vapidConfigured = process.env.VAPID_EMAIL && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
if (vapidConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("[push] Variables VAPID no configuradas — notificaciones push desactivadas.");
}

function formatPushDate(date) {
  const d = new Date(date);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}

function formatPushPrice(price) {
  if (!price || Number(price) === 0) return null;
  return "$" + Number(price).toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

async function sendPushToTenant(tenantId, payload, excludeDeviceId = null) {
  if (!vapidConfigured) return;
  try {
    const { rows } = await pool.query(
      `SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = $1`,
      [tenantId]
    );
    const message = JSON.stringify(payload);
    for (const sub of rows) {
      if (excludeDeviceId && sub.device_id === excludeDeviceId) continue;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(
            `DELETE FROM push_subscriptions WHERE tenant_id = $1 AND device_id = $2`,
            [tenantId, sub.device_id]
          );
        }
      }
    }
  } catch (err) {
    console.error("[push] Error enviando notificaciones:", err);
  }
}

const app = express();

const corsOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: corsOrigin, allowedHeaders: ["Content-Type", "Authorization", "X-Device-Id"] }));
app.use(express.json({ limit: "6mb" }));

const statusSchema = z.enum(["active", "inactive"]);
const agendaStatusSchema = z.enum(["reserved", "finished", "cancelled"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

// super_admin queda deliberadamente afuera: nadie puede auto-asignarse ni
// asignarle a otro ese rol vía estas rutas tenant-scoped. La única forma de
// crear un super_admin es una operación manual sobre la base.
const assignableUserRoles = z.enum(["admin", "staff", "user"]);

// min(8) para que una contraseña nueva nunca quede más débil que lo que el
// propio flujo de reseteo exige (resetPasswordSchema, también min 8).
const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(),
  password_hash: z.string().min(1).optional(),
  role: assignableUserRoles
}).refine((data) => data.password || data.password_hash, {
  message: "password or password_hash is required"
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  password_hash: z.string().min(1).optional(),
  role: assignableUserRoles.optional()
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
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  // Tasa real de comisión del peluquero. Reemplaza al 0.40 que estaba
  // hardcodeado en el frontend y se aplicaba por igual a todos.
  commission_rate: z.coerce.number().min(0).max(1).optional()
});

const updateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  email: z.preprocess(emptyStringToNull, z.string().email().nullable().optional()),
  status: statusSchema.optional(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  commission_rate: z.coerce.number().min(0).max(1).optional()
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
  breed: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  owner_name: z.string().min(1),
  owner_phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  neutered: z.boolean().optional().default(false),
  behavior: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  size: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  age: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  address: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  birth_date: z.preprocess(emptyStringToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
});

const updatePetSchema = z.object({
  name: z.string().min(1).optional(),
  breed: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  owner_name: z.string().min(1).optional(),
  owner_phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  neutered: z.boolean().optional(),
  behavior: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  size: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
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
  deposit_payment_method_id: z.string().uuid().optional().nullable(),
  price: z.coerce.number().min(0).optional().nullable(),
  deposit_amount: z.coerce.number().min(0).optional().default(0),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  groomer_id: z.string().uuid().optional().nullable(),
  status: agendaStatusSchema.optional().default("reserved"),
  traslado: z.boolean().optional().default(false),
  traslado_direccion: z.preprocess(emptyStringToNull, z.string().nullable().optional()),
  traslado_amount: z.coerce.number().min(0).optional().default(0),
});

const dayNoteSchema = z.object({
  date: dateSchema,
  note: z.string().max(4000),
});

const createAgendaWithNewPetSchema = z.object({
  date: dateSchema,
  time: timeSchema,
  duration: z.coerce.number().int().min(1).optional().default(60),
  service_type_id: z.string().uuid().optional().nullable(),
  payment_method_id: z.string().uuid().optional().nullable(),
  deposit_payment_method_id: z.string().uuid().optional().nullable(),
  price: z.coerce.number().min(0).optional().nullable(),
  deposit_amount: z.coerce.number().min(0).optional().default(0),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  groomer_id: z.string().uuid().optional().nullable(),
  status: agendaStatusSchema.optional().default("reserved"),
  traslado: z.boolean().optional().default(false),
  traslado_direccion: z.preprocess(emptyStringToNull, z.string().nullable().optional()),
  traslado_amount: z.coerce.number().min(0).optional().default(0),
  pet_name: z.string().min(1),
  pet_breed: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  owner_name: z.string().min(1),
  owner_phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
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
  deposit_payment_method_id: z.string().uuid().optional().nullable(),
  price: z.coerce.number().min(0).optional().nullable(),
  deposit_amount: z.coerce.number().min(0).optional(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  groomer_id: z.string().uuid().optional().nullable(),
  status: agendaStatusSchema.optional(),
  traslado: z.boolean().optional(),
  traslado_direccion: z.preprocess(emptyStringToNull, z.string().nullable().optional()),
  traslado_amount: z.coerce.number().min(0).optional(),
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
  stylist_id: z.string().uuid().optional().nullable(),
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

// Todo opcional: la pantalla de edición manda solo lo que cambió, y un campo
// ausente tiene que quedar como estaba (mandar customer_id vacío no puede
// borrar el cliente de la venta).
const updatePetshopSaleSchema = z.object({
  date: dateSchema.optional(),
  customer_id: z.string().uuid().optional().nullable(),
  stylist_id: z.string().uuid().optional().nullable(),
  payment_method_id: z.string().uuid().optional(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  total: z.coerce.number().min(0).optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.coerce.number().int().min(1),
        unit_price: z.coerce.number().min(0)
      })
    )
    .min(1)
    .optional()
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
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const updateServiceRecordSchema = z.object({
  date: z.string().min(1).optional(),
  pet_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  service_type_id: z.string().uuid().optional(),
  price: z.coerce.number().min(0).optional(),
  payment_method_id: z.string().uuid().optional(),
  groomer_id: z.string().uuid().optional().nullable(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const createSupplierSchema = z.object({
  name: z.string().min(1),
  category: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  payment_method_id: z.string().uuid().optional().nullable(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const updateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  phone: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional()),
  payment_method_id: z.string().uuid().optional().nullable(),
  notes: z.preprocess(emptyStringToNull, z.string().min(1).nullable().optional())
});

const createSupplierMovementSchema = z.object({
  date:        dateSchema,
  tipo:        z.enum(["cargo", "pago"]),
  monto:       z.coerce.number().positive(),
  descripcion: z.string().optional().nullable(),
  referencia:  z.string().optional().nullable(),
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
  status: statusSchema,
  // Vigencia: desde cuándo devenga. Sin esto, un gasto cargado hoy aparecía
  // en los números de meses en los que todavía no existía.
  start_date: dateSchema.optional(),
  end_date: z.preprocess(emptyStringToNull, dateSchema.nullable().optional())
});

const updateFixedExpenseSchema = z.object({
  name: z.string().min(1).optional(),
  category_id: z.string().uuid().optional(),
  amount: z.coerce.number().min(0).optional(),
  due_day: z.coerce.number().int().min(1).max(31).optional(),
  payment_method_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional().nullable(),
  status: statusSchema.optional(),
  start_date: dateSchema.optional(),
  end_date: z.preprocess(emptyStringToNull, dateSchema.nullable().optional())
});

const sendError = (res, status, message) => {
  return res.status(status).json({ status, message });
};

const uploadPhotoSchema = z.object({
  image: z.string().min(1)
});

const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

function decodePhotoDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return { error: "Formato de imagen inválido" };

  const [, mimeType, base64Payload] = match;
  if (!ALLOWED_PHOTO_MIME_TYPES.includes(mimeType)) {
    return { error: "Tipo de imagen no permitido (usá JPEG, PNG o WEBP)" };
  }

  const buffer = Buffer.from(base64Payload, "base64");
  if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) {
    return { error: "La imagen supera el tamaño máximo permitido (4MB)" };
  }

  return { buffer, mimeType };
}

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
    },
    remaining(key) {
      const now = Date.now();
      const timestamps = hits.get(key) ?? [];
      prune(timestamps, now);
      return Math.max(0, max - timestamps.length);
    }
  };
};

const ANTHROPIC_MODEL = "claude-sonnet-5";
// Límite real (a diferencia del contador viejo en localStorage del frontend,
// que cualquiera podía resetear borrando el storage). Ventana móvil de 30
// días en vez de mes calendario: más simple que resetear un contador el día 1.
const assistantLimiter = createRateLimiter({ windowMs: 30 * 24 * 60 * 60 * 1000, max: 20 });

// El system prompt lo arma el frontend volcando datos reales del negocio
// (servicios, clientes, turnos) como texto — para un local con actividad
// puede pasar largo los 20-30 mil caracteres sin que eso sea abuso. El límite
// real de tamaño de pedido ya lo pone express.json({ limit: "6mb" }) más
// arriba; esto solo evita algo groseramente fuera de rango.
const assistantMessageSchema = z.object({
  system: z.string().min(1).max(200000),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000)
      })
    )
    .min(1)
    .max(40)
});

// A diferencia de forgot-password (que ya tenía límite), login no tenía
// ninguno: permitía fuerza bruta de contraseñas a velocidad ilimitada.
const loginIpLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
const loginEmailLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

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
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
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

app.get("/push/vapid-public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// No existe auto-registro público a propósito: este sistema es multi-tenant y
// todo usuario no-super_admin necesita un tenant_id asignado (ver middleware
// más abajo). Las únicas formas válidas de crear un usuario son
// POST /v2/users (admin de un tenant crea gente de su propio local) y
// POST /v2/super/tenants/:id/admin (super_admin crea el admin de un local).
app.post("/auth/register", (_req, res) => {
  sendError(res, 410, "Self-registration is disabled. Contact your administrator.");
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

  const ip = getClientIp(req);
  if (!loginIpLimiter.consume(ip) || !loginEmailLimiter.consume(parsed.data.email.toLowerCase())) {
    return sendError(res, 429, "Too many requests");
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
        "SELECT status, suspended_reason FROM tenants WHERE id = $1",
        [user.tenant_id]
      );
      if (!tenantResult.rows.length || tenantResult.rows[0].status !== "active") {
        return res.status(403).json({
          message: "Tenant is inactive",
          suspended_reason: tenantResult.rows[0]?.suspended_reason ?? null,
        });
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

// Revalida rol y tenant_id contra la base en cada request, en vez de confiar
// ciegamente en lo que dice el JWT: el token dura 7 días, así que sin esto
// un cambio de rol, una baja de usuario o una suspensión de tenant tardarían
// hasta 7 días en aplicarse. Pisa req.user.role/req.tenantId con el valor
// actual -de ahí en más, requireRole() y todo el resto de la app ya
// trabajan con el dato fresco, no con el que traía el token.
app.use((req, res, next) => {
  const userId = req.user?.sub;
  if (!userId) return sendError(res, 401, "Unauthorized");

  pool.query(
    `SELECT u.role, u.tenant_id, t.status AS tenant_status, t.suspended_reason
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId]
  )
    .then(({ rows }) => {
      // El usuario del token ya no existe (lo borraron desde que se logueó).
      if (!rows.length) {
        return sendError(res, 401, "Unauthorized");
      }
      const row = rows[0];
      req.user.role = row.role;
      req.tenantId = row.tenant_id ?? null;

      // Si es super_admin y NO está en una ruta de superadmin (/v2/super/...),
      // ni en /me o /health, bloqueamos el acceso.
      if (row.role === "super_admin") {
        const path = req.path;
        const isSuperRoute = path.startsWith("/v2/super/");
        const isPublic = path === "/me" || path === "/health" || path === "/auth/logout";
        if (!isSuperRoute && !isPublic) {
          return sendError(res, 403, "Super Admin cannot access tenant data routes");
        }
        return next();
      }

      // Todo usuario no-super_admin debe tener tenant_id: es la única forma en que
      // las rutas de abajo aíslan los datos de cada local. Sin este chequeo, un
      // usuario sin tenant_id "ve" datos de todos los locales en cualquier endpoint
      // que arme su filtro como `if (req.tenantId) { ... }`.
      if (!req.tenantId) {
        return sendError(res, 403, "User has no tenant assigned");
      }

      // Verificar que el tenant del usuario esté activo.
      if (row.tenant_status !== "active") {
        return res.status(403).json({
          message: "Tenant is inactive",
          suspended_reason: row.suspended_reason ?? null,
        });
      }

      next();
    })
    .catch((err) => {
      console.error(err);
      sendError(res, 500, "Unexpected error");
    });
});

app.post("/push/subscribe", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const schema = z.object({
    device_id: z.string().min(1),
    endpoint: z.string().url(),
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid subscription data");
  const { device_id, endpoint, p256dh, auth } = parsed.data;
  await pool.query(
    `INSERT INTO push_subscriptions (tenant_id, device_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, device_id)
     DO UPDATE SET endpoint = $3, p256dh = $4, auth = $5`,
    [req.tenantId, device_id, endpoint, p256dh, auth]
  );
  res.status(201).json({ ok: true });
});

app.delete("/push/subscribe", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const { device_id } = req.body;
  if (!device_id) return sendError(res, 400, "device_id required");
  await pool.query(
    `DELETE FROM push_subscriptions WHERE tenant_id = $1 AND device_id = $2`,
    [req.tenantId, device_id]
  );
  res.json({ ok: true });
});

// Proxy del asistente de IA: el frontend arma el system prompt con los datos
// del negocio (ya los tiene, vía sus propios pedidos autenticados) y nos lo
// manda a nosotros en vez de pegarle directo a Anthropic — así la API key
// vive solo acá, nunca en el bundle del navegador.
app.post("/v2/assistant/messages", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    return sendError(res, 500, "ANTHROPIC_API_KEY is not configured");
  }

  const parsed = assistantMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "Invalid request body");
  }

  if (!assistantLimiter.consume(req.tenantId)) {
    return res.status(429).json({ message: "Monthly query limit reached", queriesLeft: 0 });
  }

  const { system, messages } = parsed.data;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // claude-sonnet-5 piensa (thinking adaptativo) por defecto salvo que
        // se desactive explícitamente, y esos tokens de razonamiento salen
        // del mismo max_tokens. Con 1024 el modelo podía gastar todo el
        // presupuesto pensando y no dejar lugar para el texto de respuesta.
        max_tokens: 16000,
        system,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.json().catch(() => ({}));
      console.error("[assistant] Anthropic error:", errBody);
      return sendError(res, 502, "AI assistant is unavailable right now");
    }

    const data = await anthropicRes.json();
    // El contenido puede traer bloques de "thinking" antes del texto (mismo
    // motivo que el max_tokens de arriba): no asumir que content[0] es el
    // texto, buscar el bloque de tipo "text".
    const textBlock = data.content?.find((block) => block.type === "text");
    const reply = textBlock?.text || "No pude generar una respuesta.";
    res.json({ reply, queriesLeft: assistantLimiter.remaining(req.tenantId) });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.tenant_id, u.created_at,
              t.name as tenant_name, t.logo_url as tenant_logo,
              t.primary_color, t.secondary_color, t.enabled_modules,
              t.status as tenant_status, t.suspended_reason
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
  // Misma condición pero calificada, para poder unir con employees sin que
  // tenant_id quede ambiguo.
  const servicesWhereClause = filters.length
    ? `WHERE ${filters.map((f) => `s.${f}`).join(" AND ")}`
    : "";


  try {
    const servicesResult = await pool.query(
      `SELECT COALESCE(SUM(price), 0) AS total
       FROM services ${whereClause}`,
      params
    );
    // La comisión del groomer es un costo del período: si no se resta acá, el
    // net_total muestra como ganancia plata que ya está comprometida. La tasa
    // se guarda como fracción (0.40 = 40%); sin groomer asignado se usa la
    // misma tasa por defecto que el resto de la app.
    const commissionsResult = await pool.query(
      `SELECT COALESCE(SUM(s.price * COALESCE(e.commission_rate, 0.40)), 0) AS total
       FROM services s
       LEFT JOIN employees e ON e.id = s.groomer_id
       ${servicesWhereClause}`,
      params
    );
    const dailyResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM daily_expenses ${whereClause}`,
      params
    );
    // Antes esto sumaba el total mensual de TODOS los activos, ignorando el
    // rango: un reporte de un día cargaba un mes entero de alquiler y uno de
    // tres meses cargaba uno solo. Ahora deriva del mismo devengado que el
    // dashboard, así que los dos números coinciden por construcción.
    const fixedTotal =
      includeFixed && req.tenantId && from && to
        ? (await getFixedExpenseAccrual(req.tenantId, from, to)).accrued_total
        : 0;

    const servicesTotal = Number(servicesResult.rows[0]?.total ?? 0);
    const dailyTotal = Number(dailyResult.rows[0]?.total ?? 0);
    const commissionsTotal = Number(commissionsResult.rows[0]?.total ?? 0);

    res.json({
      services_total: servicesTotal,
      daily_expenses_total: dailyTotal,
      fixed_expenses_total: fixedTotal,
      groomer_commissions_total: commissionsTotal,
      net_total: servicesTotal - dailyTotal - fixedTotal - commissionsTotal
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
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

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

  values.push(req.params.id, req.tenantId);

  try {
    const result = await pool.query(
      `UPDATE users SET ${fields.join(", ")}
       WHERE id = $${idx} AND tenant_id = $${idx + 1}
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

app.post("/v2/employees", requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { name, role, phone, email, status, notes, commission_rate } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO employees (name, role, phone, email, status, notes, tenant_id, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0.40))
       RETURNING *`,
      [name, role, phone ?? null, email ?? null, status, notes ?? null, req.tenantId,
       commission_rate ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/v2/employees/:id", requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const updates = parsed.data;
  const { fields, values, idx } = buildUpdate(
    ["name", "role", "phone", "email", "status", "notes", "commission_rate"],
    updates
  );
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

app.delete("/v2/employees/:id", requireRole("admin"), async (req, res) => {
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
  // Las archivadas quedan fuera salvo que se pidan explícitamente: la ficha
  // sigue existiendo (el historial la necesita), pero no ensucia las listas.
  const archivedParam =
    typeof req.query.archived === "string" ? req.query.archived.trim() : "";
  const archivedFilter = ["only", "true", "1"].includes(archivedParam)
    ? "only"
    : ["all", "include"].includes(archivedParam)
    ? "all"
    : "active";
  const filters = [];
  const params = [];

  if (req.tenantId) { params.push(req.tenantId); filters.push(`p.tenant_id = $${params.length}`); }
  if (query) {
    params.push(`%${query}%`);
    filters.push(`(p.name ILIKE $${params.length} OR p.breed ILIKE $${params.length})`);
  }
  if (archivedFilter === "active") filters.push("p.archived_at IS NULL");
  if (archivedFilter === "only") filters.push("p.archived_at IS NOT NULL");

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  // El historial real de servicios vive en agenda_turnos (no en la tabla "services",
  // que está prácticamente vacía). Se cuenta por pet_id, igual que la ficha de la
  // mascota (PetDetailPage), para que el número coincida en ambas pantallas.
  const sql = `
    SELECT p.*, COALESCE(at.service_count, 0) AS pet_service_count
    FROM pets p
    LEFT JOIN (
      SELECT pet_id, COUNT(*) AS service_count
      FROM agenda_turnos
      WHERE pet_id IS NOT NULL
      ${req.tenantId ? "AND tenant_id = $1" : ""}
      GROUP BY pet_id
    ) at ON at.pet_id = p.id
    ${whereClause}
    ORDER BY pet_service_count DESC, p.created_at DESC
  `;

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
    // services.pet_id es ON DELETE RESTRICT: si la mascota tiene servicios
    // cargados, Postgres corta el borrado. Antes eso llegaba a la pantalla como
    // "Unexpected error" y parecía que la app estaba rota.
    if (err?.code === "23503") {
      return sendError(
        res,
        409,
        "No se puede eliminar: la mascota tiene servicios registrados. Archivala para sacarla de las listas sin perder el historial."
      );
    }
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

// Archivar es el reemplazo del borrado para una mascota con historial: la saca
// de circulación sin tocar los turnos ni la facturación de meses ya cerrados.
app.post("/v2/pets/:id/archive", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  try {
    const result = await pool.query(
      `UPDATE pets SET archived_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/pets/:id/unarchive", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  try {
    const result = await pool.query(
      `UPDATE pets SET archived_at = NULL
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/pets/:id/photo", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = uploadPhotoSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const decoded = decodePhotoDataUrl(parsed.data.image);
  if (decoded.error) return sendError(res, 400, decoded.error);

  try {
    // La key de storage (pets/{id}) no lleva tenant: si subiéramos la foto
    // antes de este chequeo, un id de otra mascota de otro tenant igual
    // pisaría su archivo en Supabase Storage, aunque el UPDATE de abajo
    // rechace el guardado en la base.
    const owned = await pool.query(
      "SELECT 1 FROM pets WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    if (owned.rowCount === 0) return sendError(res, 404, "Pet not found");

    const photoUrl = await uploadPhoto("pets", req.params.id, decoded.buffer, decoded.mimeType);
    const params = [photoUrl, req.params.id];
    const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
    const result = await pool.query(
      `UPDATE pets SET photo_url = $1 WHERE id = $2${tenantClause} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Pet not found");
    res.json(result.rows[0]);
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

app.get("/agenda/day-note", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsedDate = dateSchema.safeParse(
    typeof req.query.date === "string" ? req.query.date.trim() : ""
  );
  if (!parsedDate.success) return sendError(res, 400, "Invalid date");

  try {
    const result = await pool.query(
      `SELECT n.note, n.updated_at, u.email AS updated_by_email
       FROM agenda_day_notes n
       LEFT JOIN users u ON u.id = n.updated_by
       WHERE n.tenant_id = $1 AND n.date = $2`,
      [req.tenantId, parsedDate.data]
    );
    const row = result.rows[0];
    res.json({
      date: parsedDate.data,
      note: row?.note || "",
      updated_at: row?.updated_at || null,
      updated_by_email: row?.updated_by_email || null,
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.put("/agenda/day-note", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = dayNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 400, message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
  }

  const { date, note } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO agenda_day_notes (tenant_id, date, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, date)
       DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING note, updated_at`,
      [req.tenantId, date, note, req.user?.sub ?? null]
    );
    const row = result.rows[0];
    res.json({
      date,
      note: row.note,
      updated_at: row.updated_at,
      updated_by_email: req.user?.email ?? null,
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/agenda/counts", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const parsedFrom = dateSchema.safeParse(from);
  const parsedTo = dateSchema.safeParse(to);

  if (!parsedFrom.success || !parsedTo.success) return sendError(res, 400, "Invalid date range");

  const params = [parsedFrom.data, parsedTo.data];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'finished')::int AS finished,
              COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM agenda_turnos
       WHERE date BETWEEN $1 AND $2${tenantClause}
       GROUP BY date
       ORDER BY date ASC`,
      params
    );
    res.json(result.rows);
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
    deposit_payment_method_id,
    price,
    deposit_amount,
    notes,
    groomer_id,
    status,
    traslado,
    traslado_direccion,
    traslado_amount
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO agenda_turnos
       (date, time, duration, pet_id, pet_name, breed, owner_name, service_type_id,
        payment_method_id, deposit_payment_method_id, price, deposit_amount, notes, groomer_id, status, tenant_id,
        traslado, traslado_direccion, traslado_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        date, time, duration, pet_id ?? null, pet_name, breed ?? null, owner_name,
        service_type_id, payment_method_id ?? null, deposit_payment_method_id ?? null, price ?? null, deposit_amount ?? 0,
        notes ?? null, groomer_id ?? null, status, req.tenantId,
        traslado ?? false, traslado_direccion ?? null, traslado_amount ?? 0
      ]
    );
    const turnoCreado = result.rows[0];
    res.status(201).json(turnoCreado);
    const deviceId = req.headers["x-device-id"] || null;
    sendPushToTenant(req.tenantId, {
      title: "Nuevo turno agendado",
      body: `${formatPushDate(turnoCreado.date)} · ${String(turnoCreado.time).slice(0, 5)} · ${turnoCreado.pet_name}`,
    }, deviceId);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/agenda/with-new-pet", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createAgendaWithNewPetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 400, message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
  }

  const {
    date, time, duration, service_type_id, payment_method_id, deposit_payment_method_id, price,
    deposit_amount, notes, groomer_id, status, traslado, traslado_direccion,
    traslado_amount, pet_name, pet_breed, owner_name, owner_phone,
  } = parsed.data;
  const tenantId = req.tenantId;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const customerResult = await client.query(
      `INSERT INTO customers (name, phone, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
      [owner_name, owner_phone ?? null, tenantId]
    );
    const customerId = customerResult.rows[0].id;

    const petResult = await client.query(
      `INSERT INTO pets (name, breed, owner_name, owner_phone, customer_id, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [pet_name, pet_breed ?? null, owner_name, owner_phone ?? null, customerId, tenantId]
    );
    const petId = petResult.rows[0].id;

    const turnoResult = await client.query(
      `INSERT INTO agenda_turnos
         (date, time, duration, pet_id, pet_name, breed, owner_name,
          service_type_id, payment_method_id, deposit_payment_method_id, price, deposit_amount, notes,
          groomer_id, status, tenant_id, traslado, traslado_direccion, traslado_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        date, time, duration, petId, pet_name, pet_breed ?? null, owner_name,
        service_type_id ?? null, payment_method_id ?? null, deposit_payment_method_id ?? null, price ?? null,
        deposit_amount ?? 0, notes ?? null, groomer_id ?? null, status ?? "reserved",
        tenantId, traslado ?? false, traslado_direccion ?? null, traslado_amount ?? 0,
      ]
    );

    await client.query("COMMIT");
    const turno = turnoResult.rows[0];
    res.status(201).json(turno);

    const deviceId = req.headers["x-device-id"] || null;
    sendPushToTenant(tenantId, {
      title: "Nuevo turno agendado",
      body: `${formatPushDate(turno.date)} · ${String(turno.time).slice(0, 5)} · ${turno.pet_name}`,
    }, deviceId);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
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
      "deposit_payment_method_id",
      "price",
      "deposit_amount",
      "notes",
      "groomer_id",
      "status",
      "traslado",
      "traslado_direccion",
      "traslado_amount"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  try {
    values.push(req.params.id);
    const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;

    const result = await pool.query(
      `UPDATE agenda_turnos SET ${fields.join(", ")}
       WHERE id = $${idx}${tenantClause}
       RETURNING *`,
      values
    );

    if (result.rowCount === 0) return sendError(res, 404, "Agenda item not found");
    const turno = result.rows[0];

    if (updates.status === "finished" && turno.pet_id) {
      await pool.query(
        `DELETE FROM comunicaciones_enviadas WHERE tenant_id = $1 AND pet_id = $2 AND type = 'turno'`,
        [req.tenantId, turno.pet_id]
      );
    }

    res.json(turno);
    if (updates.status === "finished") {
      const deviceId = req.headers["x-device-id"] || null;
      let serviceName = null;
      if (turno.service_type_id) {
        const svcResult = await pool.query(
          `SELECT name FROM service_types WHERE id = $1`,
          [turno.service_type_id]
        );
        serviceName = svcResult.rows[0]?.name || null;
      }
      const pricePart = formatPushPrice(turno.price);
      const bodyParts = [turno.pet_name, serviceName, pricePart].filter(Boolean);
      sendPushToTenant(req.tenantId, {
        title: "Turno finalizado",
        body: bodyParts.join(" · "),
      }, deviceId);
    }
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

app.post("/agenda/:id/photo", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = uploadPhotoSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const decoded = decodePhotoDataUrl(parsed.data.image);
  if (decoded.error) return sendError(res, 400, decoded.error);

  try {
    // Mismo motivo que en /v2/pets/:id/photo: la key de storage no lleva
    // tenant, así que hay que confirmar la pertenencia antes de subir.
    const owned = await pool.query(
      "SELECT 1 FROM agenda_turnos WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.tenantId]
    );
    if (owned.rowCount === 0) return sendError(res, 404, "Agenda item not found");

    const photoUrl = await uploadPhoto("turnos", req.params.id, decoded.buffer, decoded.mimeType);
    const params = [photoUrl, req.params.id];
    const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
    const result = await pool.query(
      `UPDATE agenda_turnos SET photo_url = $1 WHERE id = $2${tenantClause} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Agenda item not found");
    res.json(result.rows[0]);
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

app.post("/v2/payment-methods", requireRole("admin"), async (req, res) => {
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

app.put("/v2/payment-methods/:id", requireRole("admin"), async (req, res) => {
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

app.delete("/v2/payment-methods/:id", requireRole("admin"), async (req, res) => {
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

  const { date, customer_id, stylist_id, payment_method_id, notes, total, items } = parsed.data;
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
       (date, customer_id, stylist_id, payment_method_id, notes, total, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [date, customer_id ?? null, stylist_id ?? null, payment_method_id, notes ?? null, total, req.tenantId]
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

// Lee los ítems de una venta y devuelve, por producto, cuántas unidades tiene
// comprometidas. Se usa para devolver stock al editar o borrar.
async function loadSaleItems(client, saleId) {
  const result = await client.query(
    `SELECT product_id, quantity, unit_price
     FROM petshop_sale_items
     WHERE sale_id = $1
     ORDER BY id`,
    [saleId]
  );
  return result.rows;
}

// Bloquea los productos involucrados antes de tocar stock. El ORDER BY importa:
// dos ediciones simultáneas que compartan productos los toman siempre en el
// mismo orden y no se traban entre sí.
async function lockProducts(client, tenantId, productIds) {
  if (productIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT id, stock
     FROM petshop_products
     WHERE id = ANY($1::uuid[]) AND tenant_id = $2
     ORDER BY id
     FOR UPDATE`,
    [productIds, tenantId]
  );
  return new Map(result.rows.map((row) => [String(row.id), row]));
}

app.put("/v2/petshop/sales/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = updatePetshopSaleSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const updates = parsed.data;
  const { items } = updates;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const saleResult = await client.query(
      `SELECT * FROM petshop_sales WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.tenantId]
    );
    if (saleResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Sale not found");
    }

    let saleItems = null;

    if (items) {
      const previousItems = await loadSaleItems(client, req.params.id);
      // Hay que bloquear también los productos que salen de la venta: su stock
      // también se mueve (vuelve).
      const involvedIds = [
        ...new Set([
          ...previousItems.map((item) => String(item.product_id)),
          ...items.map((item) => String(item.product_id))
        ])
      ];
      const locked = await lockProducts(client, req.tenantId, involvedIds);

      const missing = items.filter((item) => !locked.has(String(item.product_id)));
      if (missing.length > 0) {
        await client.query("ROLLBACK");
        return sendError(res, 400, "Invalid product_id");
      }

      // Delta neto por producto: primero se devuelve lo que la venta tenía
      // reservado y después se descuenta lo nuevo. Así un cambio de 2 a 3
      // unidades mueve el stock en 1, no en 5.
      const deltas = new Map();
      previousItems.forEach((item) => {
        const key = String(item.product_id);
        deltas.set(key, (deltas.get(key) || 0) + Number(item.quantity));
      });
      items.forEach((item) => {
        const key = String(item.product_id);
        deltas.set(key, (deltas.get(key) || 0) - Number(item.quantity));
      });

      for (const [productId, delta] of deltas) {
        // Un producto que estaba y sigue con la misma cantidad da delta 0: no
        // tiene sentido escribirle una fila (ni moverle el updated_at).
        if (delta === 0) continue;
        // Los productos que salieron de la venta pueden haber sido borrados
        // después: si ya no existen, no hay stock que devolver.
        if (!locked.has(productId)) continue;
        await client.query(
          `UPDATE petshop_products
           SET stock = stock + $1,
               updated_at = now()
           WHERE id = $2 AND tenant_id = $3`,
          [delta, productId, req.tenantId]
        );
      }

      await client.query(`DELETE FROM petshop_sale_items WHERE sale_id = $1`, [req.params.id]);

      saleItems = [];
      for (const item of items) {
        const itemResult = await client.query(
          `INSERT INTO petshop_sale_items
           (sale_id, product_id, quantity, unit_price, tenant_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [req.params.id, item.product_id, item.quantity, item.unit_price, req.tenantId]
        );
        saleItems.push(itemResult.rows[0]);
      }
    }

    // Si cambiaron los ítems pero no mandaron total, lo recalculamos: dejar el
    // total viejo con ítems nuevos desalinea la caja del día.
    const payload = { ...updates };
    delete payload.items;
    if (items && payload.total === undefined) {
      payload.total = items.reduce(
        (sum, item) => sum + Number(item.quantity) * Number(item.unit_price),
        0
      );
    }

    const { fields, values, idx } = buildUpdate(
      ["date", "customer_id", "stylist_id", "payment_method_id", "notes", "total"],
      payload
    );

    let sale = saleResult.rows[0];
    if (fields.length > 0) {
      values.push(req.params.id);
      const tenantClause = ` AND tenant_id = $${values.push(req.tenantId)}`;
      const updated = await client.query(
        `UPDATE petshop_sales SET ${fields.join(", ")} WHERE id = $${idx}${tenantClause} RETURNING *`,
        values
      );
      sale = updated.rows[0];
    }

    // Si no se tocaron los ítems, se releen para devolver la venta completa,
    // igual que la devuelve el POST.
    const responseItems = saleItems ?? (await loadSaleItems(client, req.params.id));

    await client.query("COMMIT");
    res.json({ ...sale, items: responseItems });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

app.delete("/v2/petshop/sales/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const saleResult = await client.query(
      `SELECT id FROM petshop_sales WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.tenantId]
    );
    if (saleResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Sale not found");
    }

    // Borrar la venta sin devolver el stock deja el inventario mintiendo: los
    // productos siguen figurando como vendidos.
    const saleItems = await loadSaleItems(client, req.params.id);
    const productIds = [...new Set(saleItems.map((item) => String(item.product_id)))];
    const locked = await lockProducts(client, req.tenantId, productIds);

    const restored = new Map();
    saleItems.forEach((item) => {
      const key = String(item.product_id);
      restored.set(key, (restored.get(key) || 0) + Number(item.quantity));
    });

    for (const [productId, quantity] of restored) {
      if (!locked.has(productId)) continue;
      await client.query(
        `UPDATE petshop_products
         SET stock = stock + $1,
             updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [quantity, productId, req.tenantId]
      );
    }

    // petshop_sale_items cae por CASCADE.
    await client.query(`DELETE FROM petshop_sales WHERE id = $1 AND tenant_id = $2`, [
      req.params.id,
      req.tenantId
    ]);

    await client.query("COMMIT");
    res.json({ ok: true });
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

    const locked = await lockProducts(client, req.tenantId, [product_id]);
    const product = locked.get(String(product_id));
    if (!product) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Invalid product_id");
    }

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
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [newStock, product_id, req.tenantId]
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

app.put("/v2/services/:id", requireRole("admin"), async (req, res) => {
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

app.delete("/v2/services/:id", requireRole("admin"), async (req, res) => {
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
  const sql = `
    SELECT
      suppliers.*,
      payment_methods.name AS payment_method_name,
      COALESCE((
        SELECT
          SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE 0 END) -
          SUM(CASE WHEN tipo = 'pago'  THEN monto ELSE 0 END)
        FROM supplier_movements sm
        WHERE sm.supplier_id = suppliers.id
          AND sm.tenant_id   = suppliers.tenant_id
      ), 0) AS saldo
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

app.post("/v2/suppliers", requireRole("admin"), async (req, res) => {
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

app.put("/v2/suppliers/:id", requireRole("admin"), async (req, res) => {
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

app.delete("/v2/suppliers/:id", requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(`DELETE FROM suppliers WHERE id = $1${tenantClause}`, params);
    if (result.rowCount === 0) return sendError(res, 404, "Supplier not found");
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

// ── Supplier movements ────────────────────────────────────────────────────────

app.get("/v2/suppliers/:id/movements", async (req, res) => {
  const params = [req.params.id];
  const tenantClause = req.tenantId ? ` AND tenant_id = $${params.push(req.tenantId)}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM supplier_movements
       WHERE supplier_id = $1${tenantClause}
       ORDER BY date ASC, created_at ASC`,
      params
    );
    res.json(result.rows);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/suppliers/:id/movements", requireRole("admin"), async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createSupplierMovementSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { date, tipo, monto, descripcion, referencia } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO supplier_movements
         (supplier_id, tenant_id, date, tipo, monto, descripcion, referencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.id, req.tenantId, date, tipo, monto, descripcion ?? "", referencia ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.put("/v2/supplier-movements/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createSupplierMovementSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { date, tipo, monto, descripcion, referencia } = parsed.data;
  const params = [date, tipo, monto, descripcion ?? "", referencia ?? null, req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `UPDATE supplier_movements
       SET date=$1, tipo=$2, monto=$3, descripcion=$4, referencia=$5
       WHERE id=$6${tenantClause} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Movement not found");
    res.json(result.rows[0]);
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/supplier-movements/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const params = [req.params.id];
  const tenantClause = ` AND tenant_id = $${params.push(req.tenantId)}`;
  try {
    const result = await pool.query(
      `DELETE FROM supplier_movements WHERE id = $1${tenantClause}`,
      params
    );
    if (result.rowCount === 0) return sendError(res, 404, "Movement not found");
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

app.post("/v2/expense-categories", requireRole("admin"), async (req, res) => {
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

app.put("/v2/expense-categories/:id", requireRole("admin"), async (req, res) => {
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

app.delete("/v2/expense-categories/:id", requireRole("admin"), async (req, res) => {
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

// ─── Gastos fijos: devengamiento ────────────────────────────────────────────
// La plantilla (fixed_expenses) define QUÉ se paga y desde cuándo. Los cargos
// (fixed_expense_charges) son el hecho contable de CADA mes, con el monto
// congelado al generarse. Todo total de un período se calcula desde los cargos,
// nunca desde la plantilla — mismo criterio que supplier_movements.



// Los meses YA NO se materializan solos. El admin arma cada mes explícitamente
// (copiando el anterior), así que un mes sin lista es un dato real, no un hueco
// a rellenar. Esto devuelve qué meses del rango están sin armar para que el
// dashboard pueda avisar en vez de mostrar $0 y hacer creer que no hay costos.
async function findUnarmedPeriods(tenantId, from, to) {
  const result = await pool.query(
    `SELECT m.period::date AS period
       FROM generate_series(
              date_trunc('month', $2::timestamp),
              date_trunc('month', $3::timestamp),
              INTERVAL '1 month'
            ) AS m(period)
      WHERE NOT EXISTS (
              SELECT 1 FROM fixed_expense_periods p
               WHERE p.tenant_id = $1 AND p.period = m.period::date
            )
      ORDER BY m.period`,
    [tenantId, from, to]
  );
  return result.rows.map((row) => toDateKey(row.period));
}

// Devuelve los cargos que tocan el rango, con los días del mes que caen dentro
// de él. El prorrateo se hace sobre eso: un rango de 1 día imputa 1/30 del
// alquiler, uno de 3 meses imputa 3 alquileres.
async function fetchChargesForRange(tenantId, from, to) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.fixed_expense_id,
       c.period,
       c.due_date,
       c.amount,
       c.paid_at,
       c.paid_amount,
       c.name,
       c.category_id,
       cat.name AS category_name,
       EXTRACT(DAY FROM (c.period + INTERVAL '1 month' - INTERVAL '1 day'))::int
         AS days_in_month,
       GREATEST(0,
         (LEAST((c.period + INTERVAL '1 month' - INTERVAL '1 day')::date, $3::date)
          - GREATEST(c.period, $2::date)) + 1
       ) AS days_in_range
     FROM fixed_expense_charges c
     LEFT JOIN expense_categories cat ON cat.id = c.category_id
     WHERE c.tenant_id = $1
       AND c.period <= $3::date
       AND (c.period + INTERVAL '1 month' - INTERVAL '1 day')::date >= $2::date
     ORDER BY c.due_date, c.name`,
    [tenantId, from, to]
  );
  return result.rows;
}


// Fuente única de verdad del devengado. Tanto el dashboard como /reports/summary
// consumen esto en vez de recalcular cada uno por su lado.
async function getFixedExpenseAccrual(tenantId, from, to) {
  const [charges, unarmedPeriods] = await Promise.all([
    fetchChargesForRange(tenantId, from, to),
    findUnarmedPeriods(tenantId, from, to)
  ]);
  return { ...buildAccrual(charges, from, to), unarmed_periods: unarmedPeriods };
}

// ─── Gastos fijos: el mes como unidad editable ──────────────────────────────
// Cada mes es una lista propia. Se arma copiando el mes anterior y a partir de
// ahí se edita libre: nombre, monto, categoría, quitar ítems. Editar un mes no
// toca ningún otro, que es lo que permite corregir abril sin mover mayo.

const CHARGE_ITEM_COLUMNS = `
  c.id, c.fixed_expense_id, c.period, c.due_date, c.due_day, c.amount, c.name,
  c.category_id, c.payment_method_id, c.supplier_id,
  c.paid_at, c.paid_amount, c.created_at, c.updated_at,
  (c.updated_at > c.created_at) AS edited`;

async function fetchMonth(tenantId, periodDate) {
  const [armed, items] = await Promise.all([
    pool.query(
      `SELECT period, source, created_at FROM fixed_expense_periods
        WHERE tenant_id = $1 AND period = $2::date`,
      [tenantId, periodDate]
    ),
    pool.query(
      `SELECT ${CHARGE_ITEM_COLUMNS},
              cat.name AS category_name,
              pm.name  AS payment_method_name,
              sup.name AS supplier_name
         FROM fixed_expense_charges c
         LEFT JOIN expense_categories cat ON cat.id = c.category_id
         LEFT JOIN payment_methods    pm  ON pm.id  = c.payment_method_id
         LEFT JOIN suppliers          sup ON sup.id = c.supplier_id
        WHERE c.tenant_id = $1 AND c.period = $2::date
        ORDER BY c.due_date, c.name`,
      [tenantId, periodDate]
    )
  ]);

  const rows = items.rows.map((row) => ({
    ...row,
    period: toDateKey(row.period),
    due_date: toDateKey(row.due_date),
    amount: Number(row.amount),
    paid_at: row.paid_at ? toDateKey(row.paid_at) : null,
    paid_amount: row.paid_amount === null ? null : Number(row.paid_amount)
  }));

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const unpaid = rows.filter((row) => !row.paid_at);

  return {
    period: toDateKey(periodDate),
    // Un mes sin armar NO es un mes de $0: es un mes del que no sabemos nada.
    armed: armed.rowCount > 0,
    source: armed.rows[0]?.source ?? null,
    items: rows,
    total: Number(total.toFixed(2)),
    unpaid: {
      count: unpaid.length,
      total: Number(unpaid.reduce((sum, row) => sum + row.amount, 0).toFixed(2))
    }
  };
}


app.get("/v2/fixed-expenses/months/:period", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = periodSchema.safeParse(req.params.period);
  if (!parsed.success) return sendError(res, 400, "Período inválido (YYYY-MM)");

  const periodDate = periodToDate(parsed.data);
  try {
    const month = await fetchMonth(req.tenantId, periodDate);
    // Para ofrecer "Copiar los N de agosto" hay que saber qué hay en el mes
    // anterior sin que el front tenga que pedirlo aparte.
    const prev = previousPeriodDate(periodDate);
    const prevCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM fixed_expense_charges
        WHERE tenant_id = $1 AND period = $2::date`,
      [req.tenantId, prev]
    );
    res.json({
      ...month,
      previous_period: prev.slice(0, 7),
      previous_item_count: prevCount.rows[0]?.n ?? 0
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

const copyMonthSchema = z.object({ from: periodSchema.optional() });

// Arma un mes copiando otro. Si el mes de origen no tiene nada, siembra desde
// las plantillas vigentes — el caso del primer mes, cuando no hay anterior.
app.post("/v2/fixed-expenses/months/:period/copy", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsedPeriod = periodSchema.safeParse(req.params.period);
  if (!parsedPeriod.success) return sendError(res, 400, "Período inválido (YYYY-MM)");
  const parsedBody = copyMonthSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return sendError(res, 400, "Invalid request body");

  const periodDate = periodToDate(parsedPeriod.data);
  const sourceDate = parsedBody.data.from
    ? periodToDate(parsedBody.data.from)
    : previousPeriodDate(periodDate);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const already = await client.query(
      `SELECT 1 FROM fixed_expense_periods WHERE tenant_id = $1 AND period = $2::date`,
      [req.tenantId, periodDate]
    );
    if (already.rowCount > 0) {
      await client.query("ROLLBACK");
      return sendError(
        res,
        409,
        "Ese mes ya está armado. Editá los ítems en vez de volver a copiarlo."
      );
    }

    const copied = await client.query(
      `INSERT INTO fixed_expense_charges
         (fixed_expense_id, tenant_id, period, due_date, due_day, amount, name,
          category_id, payment_method_id, supplier_id)
       SELECT src.fixed_expense_id, src.tenant_id, $2::date,
              ${dueDateSql("$2::date", "src.due_day")}, src.due_day,
              src.amount, src.name, src.category_id, src.payment_method_id, src.supplier_id
         FROM fixed_expense_charges src
         -- La copia sale del mes anterior, pero la vigencia vive en la
         -- plantilla. Sin este filtro, "Dar de baja" no daba de baja nada: el
         -- ítem se seguía copiando mes a mes para siempre.
         LEFT JOIN fixed_expenses fe ON fe.id = src.fixed_expense_id
        WHERE src.tenant_id = $1
          AND src.period = $3::date
          -- Un ítem suelto (sin plantilla) no tiene vigencia: se copia siempre,
          -- y para cortarlo alcanza con quitarlo del mes que no lo lleva.
          AND (fe.id IS NULL OR fe.end_date IS NULL OR fe.end_date >= $2::date)`,
      [req.tenantId, periodDate, sourceDate]
    );

    let source = "copy";
    if (copied.rowCount === 0) {
      // Sin mes anterior: se siembra desde las plantillas vigentes en ese mes.
      await client.query(
        `INSERT INTO fixed_expense_charges
           (fixed_expense_id, tenant_id, period, due_date, due_day, amount, name,
            category_id, payment_method_id, supplier_id)
         SELECT fe.id, fe.tenant_id, $2::date,
                ${dueDateSql("$2::date", "fe.due_day")}, fe.due_day,
                fe.amount, fe.name, fe.category_id, fe.payment_method_id, fe.supplier_id
           FROM fixed_expenses fe
          WHERE fe.tenant_id = $1
            AND fe.status = 'active'
            AND date_trunc('month', fe.start_date)::date <= $2::date
            AND (fe.end_date IS NULL OR fe.end_date >= $2::date)`,
        [req.tenantId, periodDate]
      );
      source = "seed";
    }

    await client.query(
      `INSERT INTO fixed_expense_periods (tenant_id, period, source)
       VALUES ($1, $2::date, $3)`,
      [req.tenantId, periodDate, source]
    );

    await client.query("COMMIT");
    res.status(201).json(await fetchMonth(req.tenantId, periodDate));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

const createMonthItemSchema = z.object({
  name: z.string().min(1),
  amount: z.coerce.number().min(0),
  due_day: z.coerce.number().int().min(1).max(31),
  category_id: z.string().uuid(),
  payment_method_id: z.string().uuid(),
  supplier_id: z.preprocess(emptyStringToNull, z.string().uuid().nullable().optional()),
  // Vincular con una plantilla es opcional: un mes puede tener un gasto suelto.
  fixed_expense_id: z.preprocess(emptyStringToNull, z.string().uuid().nullable().optional())
});

// Agrega un ítem a un mes. Arma el mes si todavía no lo estaba, así cargar el
// primer gasto a mano cuenta como armarlo.
app.post("/v2/fixed-expenses/months/:period/items", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsedPeriod = periodSchema.safeParse(req.params.period);
  if (!parsedPeriod.success) return sendError(res, 400, "Período inválido (YYYY-MM)");
  const parsed = createMonthItemSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const periodDate = periodToDate(parsedPeriod.data);
  const d = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO fixed_expense_periods (tenant_id, period, source)
       VALUES ($1, $2::date, 'manual')
       ON CONFLICT (tenant_id, period) DO NOTHING`,
      [req.tenantId, periodDate]
    );
    const result = await client.query(
      `INSERT INTO fixed_expense_charges
         (fixed_expense_id, tenant_id, period, due_date, due_day, amount, name,
          category_id, payment_method_id, supplier_id)
       VALUES ($1, $2, $3::date, ${dueDateSql("$3::date", "$4::int")}, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        d.fixed_expense_id ?? null,
        req.tenantId,
        periodDate,
        d.due_day,
        d.amount,
        d.name.trim(),
        d.category_id,
        d.payment_method_id,
        d.supplier_id ?? null
      ]
    );
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

// Quita un ítem de UN mes. No da de baja el gasto: los demás meses siguen igual.
app.delete("/v2/fixed-expenses/charges/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  try {
    const result = await pool.query(
      `DELETE FROM fixed_expense_charges WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (result.rowCount === 0) return sendError(res, 404, "Charge not found");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

// OJO: debe registrarse ANTES de /v2/fixed-expenses/:id, si no Express matchea
// "accrual" como un :id.
app.get("/v2/fixed-expenses/accrual", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

  const parsedFrom = dateSchema.safeParse(
    typeof req.query.from === "string" ? req.query.from.trim() : ""
  );
  const parsedTo = dateSchema.safeParse(
    typeof req.query.to === "string" ? req.query.to.trim() : ""
  );
  if (!parsedFrom.success || !parsedTo.success) {
    return sendError(res, 400, "from y to son obligatorios (YYYY-MM-DD)");
  }
  if (parsedFrom.data > parsedTo.data) {
    return sendError(res, 400, "from no puede ser posterior a to");
  }

  try {
    res.json(await getFixedExpenseAccrual(req.tenantId, parsedFrom.data, parsedTo.data));
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

const updateFixedExpenseChargeSchema = z.object({
  // Edición de UN mes. Es deliberadamente lo único que puede reescribir un mes
  // cerrado: la plantilla nunca toca el pasado sola, y editar un mes no se
  // propaga a los demás.
  amount: z.coerce.number().min(0).optional(),
  name: z.string().min(1).optional(),
  due_day: z.coerce.number().int().min(1).max(31).optional(),
  category_id: z.string().uuid().optional(),
  payment_method_id: z.string().uuid().optional(),
  supplier_id: z.preprocess(emptyStringToNull, z.string().uuid().nullable().optional()),
  paid_at: z.preprocess(emptyStringToNull, dateSchema.nullable().optional()),
  paid_amount: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().min(0).nullable().optional()
  )
});

// Corrige el devengado de un mes puntual y/o marca el cargo como pagado.
//
// Es una actualización PARCIAL a propósito: mandar solo `amount` no debe tocar
// el estado de pago, y mandar solo `paid_at` no debe tocar el monto. La
// presencia de la clave en el body es lo que decide, así que `paid_at: null`
// (revertir un pago) se distingue de no mandar `paid_at`.
//
// Dos segmentos después del recurso, así que no colisiona con /:id.
app.put("/v2/fixed-expenses/charges/:id", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");

  const parsed = updateFixedExpenseChargeSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");

  const { amount, paid_at, paid_amount, due_day } = parsed.data;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const touchesPayment = Object.prototype.hasOwnProperty.call(body, "paid_at");

  const fields = [];
  const values = [];

  // Si en la misma llamada se corrige el monto, el pago implícito usa el monto
  // NUEVO: en un UPDATE, la columna `amount` todavía tendría el valor viejo.
  let effectiveAmountSql = "amount";
  if (amount !== undefined) {
    values.push(amount);
    fields.push(`amount = $${values.length}`);
    effectiveAmountSql = `$${values.length}::numeric`;
  }

  for (const field of ["name", "category_id", "payment_method_id", "supplier_id"]) {
    if (parsed.data[field] !== undefined) {
      values.push(parsed.data[field]);
      fields.push(`${field} = $${values.length}`);
    }
  }

  // El día de vencimiento se reclampa contra el mes de ESTE cargo, así que un
  // 31 en un mes de 30 cae el 30 en vez de perderse.
  if (due_day !== undefined) {
    values.push(due_day);
    fields.push(`due_day = $${values.length}`);
    fields.push(`due_date = ${dueDateSql("c.period", `$${values.length}::int`)}`);
  }

  if (fields.length === 0 && !touchesPayment) {
    return sendError(res, 400, "No fields to update");
  }

  if (touchesPayment) {
    values.push(paid_at ?? null);
    const paidAtIdx = values.length;
    values.push(paid_amount ?? null);
    const paidAmountIdx = values.length;
    fields.push(`paid_at = $${paidAtIdx}::date`);
    // Sin monto de pago explícito se asume que se pagó lo devengado.
    fields.push(
      `paid_amount = CASE WHEN $${paidAtIdx}::date IS NULL THEN NULL
                          ELSE COALESCE($${paidAmountIdx}::numeric, ${effectiveAmountSql}) END`
    );
  }

  fields.push("updated_at = now()");
  values.push(req.params.id);
  const idIdx = values.length;
  values.push(req.tenantId);

  try {
    const result = await pool.query(
      `UPDATE fixed_expense_charges c
          SET ${fields.join(", ")}
        WHERE c.id = $${idIdx} AND c.tenant_id = $${values.length}
        RETURNING c.*`,
      values
    );
    if (result.rowCount === 0) return sendError(res, 404, "Charge not found");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.get("/v2/fixed-expenses", async (req, res) => {
  // Este endpoint devuelve PLANTILLAS, que no tienen fecha, así que from/to no
  // aplican. Se ignoran en vez de rechazarse: el frontend es una PWA y los
  // clientes con el bundle viejo en caché siguen mandándolos. Devolver 400 les
  // rompía el dashboard entero hasta que el service worker se actualizara —
  // acoplar la versión del backend a la del cliente no vale la pena por un
  // parámetro de más. Para el total de un período está /v2/fixed-expenses/accrual.

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
    status,
    start_date,
    end_date
  } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO fixed_expenses
        (name, category_id, amount, due_day, payment_method_id, supplier_id, status,
         tenant_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               COALESCE($9::date, date_trunc('month', CURRENT_DATE)::date), $10)
       RETURNING *`,
      [
        name,
        category_id,
        amount,
        due_day,
        payment_method_id,
        supplier_id ?? null,
        status,
        req.tenantId,
        start_date ?? null,
        end_date ?? null
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

  const updates = { ...parsed.data };

  // `status` sigue siendo el control que usa la UI, pero quien manda sobre el
  // devengamiento es la vigencia. Dar de baja cierra la vigencia a fin del mes
  // en curso (el mes ya devengado se debe igual); reactivar la reabre.
  if (updates.status === "inactive" && updates.end_date === undefined) {
    updates.end_date = endOfCurrentMonth();
  }
  if (updates.status === "active" && updates.end_date === undefined) {
    updates.end_date = null;
  }

  const { fields, values, idx } = buildUpdate(
    [
      "name",
      "category_id",
      "amount",
      "due_day",
      "payment_method_id",
      "supplier_id",
      "status",
      "start_date",
      "end_date"
    ],
    updates
  );

  if (fields.length === 0) {
    return sendError(res, 400, "No fields to update");
  }

  fields.push("updated_at = now()");
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

    // El mes en curso es un período abierto: si cambia el monto o el día de
    // vencimiento, su cargo se actualiza. Los meses cerrados quedan congelados
    // — que es justamente lo que impide que la historia se reescriba sola.
    if (updates.amount !== undefined || updates.due_day !== undefined) {
      await pool.query(
        `UPDATE fixed_expense_charges c
            SET amount   = f.amount,
                due_date = (
                  c.period
                  + (LEAST(
                       f.due_day,
                       EXTRACT(DAY FROM (c.period + INTERVAL '1 month' - INTERVAL '1 day'))::int
                     ) - 1) * INTERVAL '1 day'
                )::date
           FROM fixed_expenses f
          WHERE f.id = c.fixed_expense_id
            AND c.fixed_expense_id = $1
            AND c.tenant_id = $2
            AND c.period = date_trunc('month', CURRENT_DATE)::date
            AND c.paid_at IS NULL`,
        [req.params.id, req.tenantId]
      );
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
    // FK RESTRICT desde fixed_expense_charges: borrar la plantilla huerfanaría
    // meses ya devengados y cambiaría reportes cerrados. Se da de baja, no se borra.
    if (err && err.code === "23503") {
      return sendError(
        res,
        409,
        "Este gasto ya tiene meses devengados. Marcalo como inactivo en vez de eliminarlo para no alterar reportes pasados."
      );
    }
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
  const allowed = ["name", "logo_url", "primary_color", "secondary_color", "plan", "status", "suspended_reason", "enabled_modules"];
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
    password: z.string().min(8)
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

// ── Comunicaciones enviadas ──────────────────────────────────────────────────

const createComunicacionSchema = z.object({
  petId: z.string().uuid(),
  type: z.enum(["turno", "cumple"]),
  petName: z.string().min(1),
  ownerName: z.string().optional().nullable(),
});

app.get("/v2/comunicaciones", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  try {
    const result = await pool.query(
      `SELECT id, pet_id, type, pet_name, owner_name, sent_at
       FROM comunicaciones_enviadas
       WHERE tenant_id = $1
         AND (
           (type = 'turno'  AND sent_at >= CURRENT_DATE - INTERVAL '90 days') OR
           (type = 'cumple' AND sent_at >= CURRENT_DATE - INTERVAL '365 days')
         )
       ORDER BY sent_at DESC`,
      [req.tenantId]
    );
    res.json(result.rows.map((r) => ({
      id: r.id,
      petId: r.pet_id,
      type: r.type,
      petName: r.pet_name,
      ownerName: r.owner_name,
      sentAt: r.sent_at,
    })));
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.delete("/v2/comunicaciones/:petId/:type", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const { petId, type } = req.params;
  if (!["turno", "cumple"].includes(type)) return sendError(res, 400, "Invalid type");
  try {
    await pool.query(
      `DELETE FROM comunicaciones_enviadas WHERE tenant_id = $1 AND pet_id = $2 AND type = $3`,
      [req.tenantId, petId, type]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

app.post("/v2/comunicaciones", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = createComunicacionSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid request body");
  const { petId, type, petName, ownerName } = parsed.data;
  try {
    const result = await pool.query(
      `INSERT INTO comunicaciones_enviadas
         (tenant_id, pet_id, type, pet_name, owner_name, sent_at, sent_by)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6)
       ON CONFLICT (tenant_id, pet_id, type)
       DO UPDATE SET
         pet_name   = EXCLUDED.pet_name,
         owner_name = EXCLUDED.owner_name,
         sent_at    = EXCLUDED.sent_at,
         sent_by    = EXCLUDED.sent_by
       RETURNING id, pet_id, type, pet_name, owner_name, sent_at`,
      [req.tenantId, petId, type, petName, ownerName ?? null, req.user?.sub ?? null]
    );
    const r = result.rows[0];
    res.status(201).json({
      id: r.id,
      petId: r.pet_id,
      type: r.type,
      petName: r.pet_name,
      ownerName: r.owner_name,
      sentAt: r.sent_at,
    });
  } catch (err) { console.error(err); sendError(res, 500, "Unexpected error"); }
});

// ────────────────────────────────────────────────────────────────────────────
// INGRESO DIARIOS (Daily Incomes)
// ────────────────────────────────────────────────────────────────────────────

const dailyIncomeItemSchema = z.object({
  concept: z.string().min(1),
  payment_method_id: z.string().uuid(),
  amount: z.coerce.number().min(0),
});

const saveDailyIncomesSchema = z.object({
  date: dateSchema,
  incomes: z.array(dailyIncomeItemSchema),
  notes: z.string().nullable().optional(),
});

app.get("/v2/daily-incomes", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const parsedDate = dateSchema.safeParse(date);
  if (!parsedDate.success) return sendError(res, 400, "Invalid date");

  const queryDate = parsedDate.data;
  try {
    const incomesResult = await pool.query(
      `SELECT concept, payment_method_id, amount 
       FROM daily_incomes 
       WHERE date = $1 AND tenant_id = $2`,
      [queryDate, req.tenantId]
    );

    const notesResult = await pool.query(
      `SELECT notes 
       FROM daily_income_notes 
       WHERE date = $1 AND tenant_id = $2`,
      [queryDate, req.tenantId]
    );

    res.json({
      date: queryDate,
      incomes: incomesResult.rows.map(r => ({
        concept: r.concept,
        payment_method_id: r.payment_method_id,
        amount: Number(r.amount)
      })),
      notes: notesResult.rows[0]?.notes ?? "",
      is_declared: notesResult.rowCount > 0
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

app.post("/v2/daily-incomes", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const parsed = saveDailyIncomesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 400, message: "Invalid request body", errors: parsed.error.flatten().fieldErrors });
  }

  const { date, incomes, notes } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Limpiar ingresos anteriores para esa fecha y tenant
    await client.query(
      "DELETE FROM daily_incomes WHERE date = $1 AND tenant_id = $2",
      [date, req.tenantId]
    );

    // 2. Insertar nuevos ingresos con monto > 0
    for (const inc of incomes) {
      if (inc.amount > 0) {
        await client.query(
          `INSERT INTO daily_incomes (date, concept, payment_method_id, amount, tenant_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [date, inc.concept, inc.payment_method_id, inc.amount, req.tenantId]
        );
      }
    }

    // 3. Upsert de las notas/observaciones del día
    await client.query(
      `INSERT INTO daily_income_notes (tenant_id, date, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, date) 
       DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()`,
      [req.tenantId, date, notes ?? null]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    sendError(res, 500, "Unexpected error");
  } finally {
    client.release();
  }
});

app.get("/v2/daily-incomes/system-totals", async (req, res) => {
  if (!req.tenantId) return sendError(res, 403, "No tenant context");
  const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const parsedDate = dateSchema.safeParse(date);
  if (!parsedDate.success) return sendError(res, 400, "Invalid date");

  const queryDate = parsedDate.data;
  const tenantId = req.tenantId;

  try {
    // 1. Servicios desde turnos finalizados en agenda (neto: precio - seña anticipada)
    const agendaServices = await pool.query(
      `SELECT payment_method_id,
              SUM(COALESCE(price, 0) - COALESCE(deposit_amount, 0)) AS total
       FROM agenda_turnos
       WHERE date = $1 AND tenant_id = $2 AND status = 'finished' AND payment_method_id IS NOT NULL
       GROUP BY payment_method_id`,
      [queryDate, tenantId]
    );

    // 1b. Servicios cargados manualmente en el módulo de servicios
    const tableServices = await pool.query(
      `SELECT payment_method_id, SUM(COALESCE(price, 0)) AS total
       FROM services
       WHERE date = $1 AND tenant_id = $2 AND payment_method_id IS NOT NULL
       GROUP BY payment_method_id`,
      [queryDate, tenantId]
    );

    // 2. Señas desde agenda_turnos (status != cancelled)
    // Usa el método de pago propio de la seña; si no está cargado (turnos viejos), cae al método de pago del saldo.
    const agendaDeposits = await pool.query(
      `SELECT COALESCE(deposit_payment_method_id, payment_method_id) AS payment_method_id, SUM(COALESCE(deposit_amount, 0)) AS total
       FROM agenda_turnos
       WHERE date = $1 AND tenant_id = $2 AND status != 'cancelled' AND deposit_amount > 0
             AND COALESCE(deposit_payment_method_id, payment_method_id) IS NOT NULL
       GROUP BY COALESCE(deposit_payment_method_id, payment_method_id)`,
      [queryDate, tenantId]
    );

    // 4. Traslados desde agenda_turnos (status = finished, traslado = true, traslado_amount > 0)
    const agendaTraslados = await pool.query(
      `SELECT payment_method_id, SUM(COALESCE(traslado_amount, 0)) AS total
       FROM agenda_turnos
       WHERE date = $1 AND tenant_id = $2 AND status = 'finished' AND traslado = true AND traslado_amount > 0 AND payment_method_id IS NOT NULL
       GROUP BY payment_method_id`,
      [queryDate, tenantId]
    );

    // 5. Ventas PetShop desde petshop_sales
    const petshopSales = await pool.query(
      `SELECT payment_method_id, SUM(COALESCE(total, 0)) AS total
       FROM petshop_sales
       WHERE date = $1 AND tenant_id = $2 AND payment_method_id IS NOT NULL
       GROUP BY payment_method_id`,
      [queryDate, tenantId]
    );

    const map = new Map();

    const addValue = (concept, pmId, value) => {
      const val = Number(value || 0);
      if (val === 0) return;
      const key = `${concept}:${pmId}`;
      const current = map.get(key) || 0;
      map.set(key, current + val);
    };

    // Agregar servicios desde turnos finalizados (neto de seña)
    for (const r of agendaServices.rows) {
      addValue("servicios", r.payment_method_id, r.total);
    }
    // Agregar servicios cargados manualmente
    for (const r of tableServices.rows) {
      addValue("servicios", r.payment_method_id, r.total);
    }
    // Agregar señas de agenda turnos
    for (const r of agendaDeposits.rows) {
      addValue("señas", r.payment_method_id, r.total);
    }
    // Agregar traslados
    for (const r of agendaTraslados.rows) {
      addValue("traslados", r.payment_method_id, r.total);
    }
    // Agregar ventas petshop
    for (const r of petshopSales.rows) {
      addValue("ventas_petshop", r.payment_method_id, r.total);
    }

    const response = [];
    for (const [key, amount] of map.entries()) {
      const [concept, payment_method_id] = key.split(":");
      response.push({
        concept,
        payment_method_id,
        amount
      });
    }

    res.json(response);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "Unexpected error");
  }
});

// ────────────────────────────────────────────────────────────────────────────

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
