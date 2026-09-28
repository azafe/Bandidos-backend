// Tests del motor de horarios de la web de reservas. No tocan base ni HTTP:
// importan la lógica pura de src/booking.js.
//
// Lo que se protege acá es que la web nunca ofrezca un horario que el local
// no puede cumplir: fuera de horario, pisando un bloqueo, con el cupo lleno o
// sin la anticipación mínima. Un horario de más es un cliente que llega y no
// hay quién lo atienda.
import assert from "node:assert/strict";
import test from "node:test";

const {
  computeDaySlots,
  resolveServiceOffer,
  summarizeServiceOffer,
  argentinaNow,
  slugify,
  timeToMinutes,
  minutesToTime,
  addDays,
  weekdayOf,
  bookingHoursSchema,
  bookingSettingsSchema,
  sizePricingSchema
} = await import("../src/booking.js");

// Lunes 5/10/2026, 08:00 en Argentina.
const NOW = { date: "2026-10-05", minutes: 8 * 60 };
const MORNING = [{ start_time: "09:00", end_time: "12:00" }];

const slots = (overrides = {}) =>
  computeDaySlots({
    date: "2026-10-06",
    ranges: MORNING,
    capacity: 1,
    interval: 30,
    duration: 60,
    now: NOW,
    minNoticeMinutes: 0,
    maxDaysAhead: 30,
    ...overrides
  });

test("ofrece horarios cada `interval` que entran completos en la franja", () => {
  assert.deepEqual(slots(), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert.deepEqual(slots({ interval: 60 }), ["09:00", "10:00", "11:00"]);
  assert.deepEqual(slots({ duration: 180 }), ["09:00"]);
  assert.deepEqual(slots({ duration: 181 }), []);
});

test("un día sin franjas o marcado como cerrado no ofrece nada", () => {
  assert.deepEqual(slots({ ranges: [] }), []);
  assert.deepEqual(slots({ closed: true }), []);
});

test("junta varias franjas del mismo día (corte al mediodía)", () => {
  const result = slots({
    ranges: [
      { start_time: "16:00", end_time: "18:00" },
      { start_time: "09:00", end_time: "11:00" }
    ],
    interval: 60
  });
  assert.deepEqual(result, ["09:00", "10:00", "16:00", "17:00"]);
});

test("dos franjas pegadas cuentan como una: el servicio puede cruzar el límite", () => {
  const result = slots({
    ranges: [
      { start_time: "09:00", end_time: "10:00" },
      { start_time: "10:00", end_time: "11:00" }
    ],
    duration: 90
  });
  assert.deepEqual(result, ["09:00", "09:30"]);
});

test("con cupo 1, un turno existente tapa los horarios que se le superponen", () => {
  const result = slots({ appointments: [{ time: "10:00:00", duration: 60 }] });
  // 09:00-10:00 termina justo cuando empieza el turno: sí se ofrece.
  // 09:30, 10:00 y 10:30 se superponen. 11:00 empieza cuando termina.
  assert.deepEqual(result, ["09:00", "11:00"]);
});

test("con cupo 2, recién se llena cuando hay dos turnos simultáneos", () => {
  const one = slots({ capacity: 2, appointments: [{ time: "10:00", duration: 60 }] });
  assert.deepEqual(one, ["09:00", "09:30", "10:00", "10:30", "11:00"]);

  const two = slots({
    capacity: 2,
    appointments: [
      { time: "10:00", duration: 60 },
      { time: "10:30", duration: 60 }
    ]
  });
  // 10:30-11:00 tiene dos turnos a la vez: todo lo que la toque queda afuera.
  assert.deepEqual(two, ["09:00", "09:30", "11:00"]);
});

test("dos turnos que no se pisan entre sí no cuentan como simultáneos", () => {
  // 09:00-10:00 y 10:00-11:00 nunca coinciden: con cupo 2 queda lugar para
  // un servicio de 09:30 a 10:30 (a lo sumo 2 a la vez).
  const result = slots({
    capacity: 2,
    appointments: [
      { time: "09:00", duration: 60 },
      { time: "10:00", duration: 60 }
    ]
  });
  assert.ok(result.includes("09:30"));
});

test("un bloqueo ocupa todos los cupos de su franja", () => {
  const result = slots({ capacity: 5, blocks: [{ start_time: "10:15", end_time: "10:45" }] });
  assert.deepEqual(result, ["09:00", "11:00"]);
});

test("respeta la anticipación mínima, incluso si cruza al día siguiente", () => {
  // Hoy a las 08:00 con 2 h de anticipación: el primer horario de hoy es 10:00.
  const today = slots({ date: NOW.date, minNoticeMinutes: 120 });
  assert.deepEqual(today, ["10:00", "10:30", "11:00"]);

  // 24 h de anticipación desde el lunes 08:00: el martes arranca a las 08:00,
  // así que toda la mañana del martes vale; 26 h ya corta las 09:00 y 09:30.
  assert.deepEqual(slots({ minNoticeMinutes: 24 * 60 }), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert.deepEqual(slots({ minNoticeMinutes: 26 * 60 }), ["10:00", "10:30", "11:00"]);
});

test("no ofrece días pasados ni más allá de la anticipación máxima", () => {
  assert.deepEqual(slots({ date: "2026-10-04" }), []);
  assert.deepEqual(slots({ date: addDays(NOW.date, 30), maxDaysAhead: 30 }).length, 5);
  assert.deepEqual(slots({ date: addDays(NOW.date, 31), maxDaysAhead: 30 }), []);
});

test("hoy no ofrece horarios que ya pasaron", () => {
  const result = slots({ date: NOW.date, now: { date: NOW.date, minutes: 10 * 60 + 10 } });
  assert.deepEqual(result, ["10:30", "11:00"]);
});

test("precio y duración según tamaño, con respaldo en los valores generales", () => {
  const bano = {
    default_price: "15000.00",
    duration_minutes: 60,
    size_pricing: { grande: { price: 22000, duration: 90 }, gigante: { price: 30000 } }
  };
  assert.deepEqual(resolveServiceOffer(bano, "chico"), { price: 15000, duration: 60 });
  assert.deepEqual(resolveServiceOffer(bano, "grande"), { price: 22000, duration: 90 });
  assert.deepEqual(resolveServiceOffer(bano, "gigante"), { price: 30000, duration: 60 });
  assert.deepEqual(resolveServiceOffer(bano, undefined), { price: 15000, duration: 60 });

  // Sin duración cargada, se asume una hora.
  assert.deepEqual(resolveServiceOffer({ default_price: null, size_pricing: {} }, "chico"), {
    price: null,
    duration: 60
  });

  assert.deepEqual(summarizeServiceOffer(bano), {
    price_from: 15000,
    duration_min: 60,
    duration_max: 90,
    varies_by_size: true
  });
});

test("argentinaNow convierte desde UTC (Argentina es UTC-3)", () => {
  // 02:30 UTC del 6/10 son las 23:30 del 5/10 en Argentina.
  assert.deepEqual(argentinaNow(new Date("2026-10-06T02:30:00Z")), { date: "2026-10-05", minutes: 23 * 60 + 30 });
});

test("helpers de fechas y horas", () => {
  assert.equal(timeToMinutes("09:30:00"), 570);
  assert.equal(minutesToTime(570), "09:30");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayOf("2026-10-04"), 0); // domingo
});

test("slugify arma un link limpio desde el nombre del local", () => {
  assert.equal(slugify("Peluquería Canina Bandidos!"), "peluqueria-canina-bandidos");
  assert.equal(slugify("  --Ñandú  & Co-- "), "nandu-co");
});

test("valida el horario semanal: sin franjas invertidas ni superpuestas", () => {
  const ok = bookingHoursSchema.safeParse({
    hours: [
      { weekday: 1, start_time: "09:00", end_time: "13:00" },
      { weekday: 1, start_time: "13:00", end_time: "18:00" }
    ]
  });
  assert.equal(ok.success, true);

  const overlap = bookingHoursSchema.safeParse({
    hours: [
      { weekday: 1, start_time: "09:00", end_time: "13:00" },
      { weekday: 1, start_time: "12:00", end_time: "18:00" }
    ]
  });
  assert.equal(overlap.success, false);

  const inverted = bookingHoursSchema.safeParse({ hours: [{ weekday: 2, start_time: "18:00", end_time: "09:00" }] });
  assert.equal(inverted.success, false);
});

test("valida la configuración y el precio por tamaño", () => {
  assert.equal(bookingSettingsSchema.safeParse({ slug: "Bandidos" }).data.slug, "bandidos");
  assert.equal(bookingSettingsSchema.safeParse({ slug: "con espacio" }).success, false);
  assert.equal(bookingSettingsSchema.safeParse({ slot_interval: 20 }).success, false);
  assert.equal(bookingSettingsSchema.safeParse({ address: "  " }).data.address, null);

  assert.equal(sizePricingSchema.safeParse({ chico: { price: 1000, duration: 45 } }).success, true);
  assert.equal(sizePricingSchema.safeParse({ enorme: { price: 1 } }).success, false);
});
