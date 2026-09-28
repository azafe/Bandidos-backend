// src/booking.js
//
// Lógica pura de la web de reservas: sin acceso a base ni a HTTP, para poder
// testearla sin levantar la app. Las consultas viven en index.js; acá están
// las validaciones, el precio/duración según el tamaño del perro y el cálculo
// de horarios libres.
//
// Todas las fechas son "YYYY-MM-DD" y todas las horas "HH:MM" en hora de
// Argentina, igual que agenda_turnos.date/time. Internamente las horas se
// manejan como minutos desde las 00:00.
import { z } from "zod";

export const BOOKING_TIMEZONE = "America/Argentina/Buenos_Aires";
export const BOOKING_SIZES = ["chico", "mediano", "grande", "gigante"];
const DEFAULT_DURATION = 60;

// ── Horas y fechas ─────────────────────────────────────────────────────────

// "09:30" o "09:30:00" (como lo devuelve pg) -> 570.
export function timeToMinutes(value) {
  const [h, m] = String(value).split(":");
  return Number(h) * 60 + Number(m);
}

// 570 -> "09:30".
export function minutesToTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Días enteros entre dos fechas (b - a).
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// 0 = domingo, igual que booking_hours.weekday y EXTRACT(DOW ...).
export function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// Fecha y minuto actuales en Argentina. El servidor corre en UTC, así que no
// se puede usar new Date().getHours().
export function argentinaNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: BOOKING_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

// ── Slug del link público ──────────────────────────────────────────────────

// "Peluquería Bandidos!" -> "peluqueria-bandidos".
export function slugify(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

// ── Precio y duración según tamaño ─────────────────────────────────────────

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Precio y duración de un servicio para un tamaño. Si el tamaño no tiene
// valores propios en size_pricing se usan default_price y duration_minutes.
export function resolveServiceOffer(serviceType, size) {
  const bySize = (size && serviceType?.size_pricing?.[size]) || {};
  const price = toNumberOrNull(bySize.price) ?? toNumberOrNull(serviceType?.default_price);
  const duration =
    toNumberOrNull(bySize.duration) ??
    toNumberOrNull(serviceType?.duration_minutes) ??
    DEFAULT_DURATION;
  return { price, duration };
}

// Lo que muestra la tarjeta del servicio: "desde $X" y el rango de duración.
export function summarizeServiceOffer(serviceType) {
  const offers = [resolveServiceOffer(serviceType, null)];
  for (const size of BOOKING_SIZES) {
    if (serviceType?.size_pricing?.[size]) offers.push(resolveServiceOffer(serviceType, size));
  }
  const prices = offers.map((o) => o.price).filter((p) => p !== null);
  const durations = offers.map((o) => o.duration);
  return {
    price_from: prices.length ? Math.min(...prices) : null,
    duration_min: Math.min(...durations),
    duration_max: Math.max(...durations),
    varies_by_size: BOOKING_SIZES.some((s) => serviceType?.size_pricing?.[s])
  };
}

// ── Disponibilidad ─────────────────────────────────────────────────────────

// Máxima cantidad de turnos simultáneos dentro de [start, end).
function maxConcurrent(appointments, start, end) {
  const events = [];
  for (const a of appointments) {
    const s = Math.max(a.start, start);
    const e = Math.min(a.end, end);
    if (s < e) {
      events.push([s, 1], [e, -1]);
    }
  }
  // A igual minuto, primero las salidas: un turno que termina 10:00 no se
  // superpone con otro que empieza 10:00.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

// Une franjas que se tocan o se superponen: 09-13 y 13-20 son una sola
// franja de atención, y un servicio de 11:30 a 13:30 entra.
function mergeRanges(ranges) {
  const sorted = ranges
    .map((r) => ({ start: timeToMinutes(r.start_time), end: timeToMinutes(r.end_time) }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// Horarios de inicio libres de un día para un servicio de `duration` minutos.
//
// ranges:       franjas de atención del día [{start_time, end_time}]
// closed:       el día está marcado como cerrado
// appointments: turnos no cancelados del día [{time, duration}]
// blocks:       franjas bloqueadas del día [{start_time, end_time}]
// now:          { date, minutes } en hora de Argentina (argentinaNow())
//
// Un horario se ofrece si: entra completo dentro de una franja, respeta la
// anticipación mínima y máxima, no toca ningún bloqueo y en ningún momento
// del servicio se llega al cupo de perros simultáneos.
export function computeDaySlots({
  date,
  ranges = [],
  closed = false,
  appointments = [],
  blocks = [],
  capacity = 1,
  interval = 30,
  duration = DEFAULT_DURATION,
  now,
  minNoticeMinutes = 0,
  maxDaysAhead = 30
}) {
  if (closed || !ranges.length) return [];

  const dayOffset = daysBetween(now.date, date);
  if (dayOffset < 0 || dayOffset > maxDaysAhead) return [];

  // Primer minuto reservable, medido desde las 00:00 de `date`.
  const earliest = now.minutes + minNoticeMinutes - dayOffset * 1440;

  const busy = appointments.map((a) => {
    const start = timeToMinutes(a.time);
    return { start, end: start + Number(a.duration || DEFAULT_DURATION) };
  });
  const blocked = blocks.map((b) => ({ start: timeToMinutes(b.start_time), end: timeToMinutes(b.end_time) }));

  const slots = new Set();
  for (const range of mergeRanges(ranges)) {
    for (let start = range.start; start + duration <= range.end; start += interval) {
      const end = start + duration;
      if (start < earliest) continue;
      if (blocked.some((b) => b.start < end && start < b.end)) continue;
      if (maxConcurrent(busy, start, end) >= capacity) continue;
      slots.add(start);
    }
  }
  return [...slots].sort((a, b) => a - b).map(minutesToTime);
}

// ── Validaciones de la configuración ───────────────────────────────────────

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const optionalText = (max) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable().optional()
  );

export const bookingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    address: optionalText(200),
    whatsapp: optionalText(40),
    cancellation_policy: optionalText(1000),
    capacity: z.number().int().min(1).max(20),
    slot_interval: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    min_notice_minutes: z.number().int().min(0).max(10080),
    max_days_ahead: z.number().int().min(1).max(180),
    cancel_hours: z.number().int().min(0).max(168)
  })
  .partial();

const hourRangeSchema = z
  .object({ weekday: z.number().int().min(0).max(6), start_time: hhmm, end_time: hhmm })
  .refine((r) => timeToMinutes(r.start_time) < timeToMinutes(r.end_time), {
    message: "start_time must be before end_time"
  });

// Reemplaza el horario semanal completo. Las franjas de un mismo día no
// pueden superponerse.
export const bookingHoursSchema = z
  .object({ hours: z.array(hourRangeSchema).max(50) })
  .refine(
    ({ hours }) => {
      for (let day = 0; day < 7; day += 1) {
        const ranges = hours
          .filter((h) => h.weekday === day)
          .map((h) => [timeToMinutes(h.start_time), timeToMinutes(h.end_time)])
          .sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < ranges.length; i += 1) {
          if (ranges[i][0] < ranges[i - 1][1]) return false;
        }
      }
      return true;
    },
    { message: "Overlapping ranges on the same day" }
  );

export const closedDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: optionalText(200)
});

const sizeOfferSchema = z.object({
  price: z.number().nonnegative().nullable().optional(),
  duration: z.number().int().min(5).max(600).nullable().optional()
});

export const sizePricingSchema = z
  .object(Object.fromEntries(BOOKING_SIZES.map((s) => [s, sizeOfferSchema.optional()])))
  .strict();

export const availabilityQuerySchema = z.object({
  service_type_id: z.string().uuid(),
  size: z.enum(BOOKING_SIZES).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(31).default(14)
});

// ── Reserva del cliente ────────────────────────────────────────────────────

const requiredText = (max) => z.string().trim().min(1).max(max);

export const reservationSchema = z.object({
  service_type_id: z.string().uuid(),
  size: z.enum(BOOKING_SIZES),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: hhmm,
  owner_name: requiredText(120),
  phone: z
    .string()
    .trim()
    .max(40)
    .refine((v) => phoneKey(v).length >= 8, { message: "Invalid phone" }),
  pet_name: requiredText(80),
  breed: optionalText(80),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().email().max(160).nullable().optional()
  ),
  notes: optionalText(500),
  accept_policy: z.literal(true),
  // Campo trampa: invisible para una persona, los bots lo completan.
  website: z.string().max(0).optional()
});

// Clave para comparar celulares cargados de formas distintas
// ("+54 9 381 555-1234", "3815551234", "0381 15 555 1234"): los últimos 10
// dígitos, que en Argentina son característica + número.
export function phoneKey(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.slice(-10);
}

// Minutos que faltan para el turno, medidos en hora de Argentina.
export function minutesUntil({ date, time }, now) {
  return daysBetween(now.date, date) * 1440 + timeToMinutes(time) - now.minutes;
}

// El cliente puede cancelar solo si el turno sigue reservado y falta al menos
// `cancelHours` horas.
export function canCancelReservation(turno, cancelHours, now) {
  if (turno.status !== "reserved") return false;
  return minutesUntil(turno, now) >= cancelHours * 60;
}

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function formatLongDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC"
  }).replace(",", "");
}

// Email de confirmación para el cliente (texto y HTML).
export function buildReservationEmail({ businessName, address, petName, serviceName, date, time, price, manageUrl }) {
  const when = `${formatLongDate(date)} a las ${time}`;
  const priceText = price !== null && price !== undefined ? `$${Number(price).toLocaleString("es-AR")}` : null;
  const lines = [
    `¡Tu turno en ${businessName} quedó reservado!`,
    "",
    `Mascota: ${petName}`,
    `Servicio: ${serviceName}`,
    `Cuándo: ${when}`,
    address ? `Dónde: ${address}` : null,
    priceText ? `Precio: ${priceText}` : null,
    "",
    manageUrl ? `Si no podés venir, cancelalo desde acá: ${manageUrl}` : null
  ].filter((l) => l !== null);

  const html = `<p><strong>¡Tu turno en ${escapeHtml(businessName)} quedó reservado!</strong></p>
<p>Mascota: ${escapeHtml(petName)}<br>Servicio: ${escapeHtml(serviceName)}<br>Cuándo: ${escapeHtml(when)}${
    address ? `<br>Dónde: ${escapeHtml(address)}` : ""
  }${priceText ? `<br>Precio: ${escapeHtml(priceText)}` : ""}</p>${
    manageUrl ? `<p>Si no podés venir, <a href="${escapeHtml(manageUrl)}">cancelá tu turno acá</a>.</p>` : ""
  }`;

  return { subject: `Turno reservado en ${businessName}`, text: lines.join("\n"), html };
}
