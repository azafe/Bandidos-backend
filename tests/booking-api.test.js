// Tests HTTP de la web de reservas (entrega 1): rutas públicas de portada y
// disponibilidad, y configuración del local. La base es un doble en memoria
// que reconoce solo las consultas de estas rutas.
//
// Lo importante:
// - las rutas públicas andan sin token y solo ven datos del local del slug;
// - un servicio no publicado o de otro local no se puede consultar;
// - la configuración solo la toca un admin, y el link no se puede repetir.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { signTokenFor, handleAuthRevalidation } from "./helpers/authRevalidation.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const { addDays, argentinaNow, weekdayOf } = await import("../src/booking.js");

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const SERVICE_ONLINE = crypto.randomUUID();
const SERVICE_HIDDEN = crypto.randomUUID();
const SERVICE_OTHER_TENANT = crypto.randomUUID();

// Pasado mañana: lejos de la anticipación mínima y dentro de la máxima.
const TARGET = addDays(argentinaNow().date, 2);

function createFakeDb() {
  const tenants = new Map([
    [TENANT_A, { id: TENANT_A, name: "Peluquería Bandidos", status: "active", logo_url: null }],
    [TENANT_B, { id: TENANT_B, name: "Otro Local", status: "active", logo_url: null }]
  ]);
  const settings = new Map([
    [TENANT_B, {
      tenant_id: TENANT_B, enabled: true, slug: "otro-local", address: null, whatsapp: null,
      cancellation_policy: null, capacity: 1, slot_interval: 30, min_notice_minutes: 0,
      max_days_ahead: 30, cancel_hours: 24
    }]
  ]);
  const serviceTypes = [
    {
      id: SERVICE_ONLINE, tenant_id: TENANT_A, name: "Baño", description: null, online_enabled: true,
      default_price: "15000.00", duration_minutes: 60, size_pricing: { grande: { price: 22000, duration: 90 } }
    },
    {
      id: SERVICE_HIDDEN, tenant_id: TENANT_A, name: "Corte a tijera", description: null, online_enabled: false,
      default_price: "20000.00", duration_minutes: 120, size_pricing: {}
    },
    {
      id: SERVICE_OTHER_TENANT, tenant_id: TENANT_B, name: "Baño B", description: null, online_enabled: true,
      default_price: "1.00", duration_minutes: 60, size_pricing: {}
    }
  ];
  // Lunes a domingo, 09:00 a 12:00, para los dos locales.
  const hours = [TENANT_A, TENANT_B].flatMap((tenant_id) =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenant_id, weekday, start_time: "09:00:00", end_time: "12:00:00" }))
  );
  const turnos = [
    { tenant_id: TENANT_A, date: TARGET, time: "10:00:00", duration: 60, status: "reserved" },
    // Cancelado y de otro local: no deben ocupar lugar en el local A.
    { tenant_id: TENANT_A, date: TARGET, time: "09:00:00", duration: 60, status: "cancelled" },
    { tenant_id: TENANT_B, date: TARGET, time: "11:00:00", duration: 60, status: "reserved" }
  ];
  const blocks = [];
  const closedDays = [];
  const queries = [];

  const query = async (sql, params = []) => {
    const authRow = handleAuthRevalidation(sql, params);
    if (authRow) return authRow;
    const q = norm(sql);
    queries.push({ q, params });

    if (q.startsWith("select bs.*, t.name as tenant_name")) {
      const s = [...settings.values()].find((row) => row.slug === params[0]);
      const tenant = s && tenants.get(s.tenant_id);
      if (!s || tenant.status !== "active") return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ ...s, tenant_name: tenant.name, logo_url: null, primary_color: null, secondary_color: null }] };
    }

    if (q.startsWith("select weekday, to_char(start_time") || q.startsWith("select id, weekday, to_char(start_time")) {
      const rows = hours
        .filter((h) => h.tenant_id === params[0])
        .map((h) => ({ id: crypto.randomUUID(), weekday: h.weekday, start_time: h.start_time.slice(0, 5), end_time: h.end_time.slice(0, 5) }));
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("select weekday, start_time, end_time from booking_hours")) {
      const rows = hours.filter((h) => h.tenant_id === params[0]);
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("select id, name, description, default_price")) {
      const rows = serviceTypes.filter((s) => s.tenant_id === params[0] && s.online_enabled);
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("select id, name, default_price, duration_minutes, size_pricing from service_types")) {
      const rows = serviceTypes.filter((s) => s.id === params[0] && s.tenant_id === params[1] && s.online_enabled);
      return { rowCount: rows.length, rows };
    }

    if (q.includes("from booking_closed_days where tenant_id = $1 and date between")) {
      const rows = closedDays.filter((c) => c.tenant_id === params[0] && c.date >= params[1] && c.date <= params[2]);
      return { rowCount: rows.length, rows };
    }

    if (q.includes("from agenda_turnos where tenant_id = $1 and date between")) {
      const rows = turnos.filter(
        (t) => t.tenant_id === params[0] && t.date >= params[1] && t.date <= params[2] && ["reserved", "finished"].includes(t.status)
      );
      return { rowCount: rows.length, rows };
    }

    if (q.includes("from agenda_blocks where tenant_id = $1 and date between")) {
      const rows = blocks.filter((b) => b.tenant_id === params[0] && b.date >= params[1] && b.date <= params[2]);
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("select * from booking_settings where tenant_id = $1")) {
      const row = settings.get(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    }

    if (q.startsWith("select slug from booking_settings where tenant_id = $1")) {
      const row = settings.get(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ slug: row.slug }] : [] };
    }

    if (q.startsWith("select slug, enabled from booking_settings where tenant_id = $1")) {
      const row = settings.get(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [{ slug: row.slug, enabled: row.enabled }] : [] };
    }

    if (q.startsWith("select name from tenants where id = $1")) {
      const tenant = tenants.get(params[0]);
      return { rowCount: tenant ? 1 : 0, rows: tenant ? [{ name: tenant.name }] : [] };
    }

    if (q.includes("from booking_closed_days where tenant_id = $1 and date >= $2")) {
      const rows = closedDays.filter((c) => c.tenant_id === params[0] && c.date >= params[1]);
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("insert into booking_settings")) {
      const cols = sql.match(/\(([^)]+)\)/)[1].split(",").map((c) => c.trim());
      const incoming = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
      const clash = [...settings.values()].find((s) => s.slug && s.slug === incoming.slug && s.tenant_id !== incoming.tenant_id);
      if (clash) {
        const err = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      const current = settings.get(incoming.tenant_id) ?? {
        enabled: false, slug: null, address: null, whatsapp: null, cancellation_policy: null,
        capacity: 1, slot_interval: 30, min_notice_minutes: 120, max_days_ahead: 30, cancel_hours: 24
      };
      settings.set(incoming.tenant_id, { ...current, ...incoming });
      return { rowCount: 1, rows: [] };
    }

    if (q.startsWith("insert into agenda_blocks")) {
      const row = { id: crypto.randomUUID(), tenant_id: params[0], date: params[1], start_time: params[2], end_time: params[3], reason: params[4] };
      blocks.push(row);
      return { rowCount: 1, rows: [{ id: row.id, date: row.date, start_time: row.start_time, end_time: row.end_time, reason: row.reason }] };
    }

    if (q.includes("from agenda_blocks where tenant_id = $1 and date between $2 and $3 order by")) {
      const rows = blocks.filter((b) => b.tenant_id === params[0] && b.date >= params[1] && b.date <= params[2]);
      return { rowCount: rows.length, rows };
    }

    if (q.startsWith("delete from agenda_blocks")) {
      const i = blocks.findIndex((b) => b.id === params[0] && b.tenant_id === params[1]);
      if (i < 0) return { rowCount: 0, rows: [] };
      blocks.splice(i, 1);
      return { rowCount: 1, rows: [] };
    }

    if (q.startsWith("insert into booking_closed_days")) {
      const row = { id: crypto.randomUUID(), tenant_id: params[0], date: params[1], reason: params[2] };
      closedDays.push(row);
      return { rowCount: 1, rows: [{ id: row.id, date: row.date, reason: row.reason }] };
    }

    throw new Error(`Unexpected SQL in booking API test: ${sql}`);
  };

  return { query, queries, closedDays, blocks, settings };
}

const request = async (baseUrl, path, { method = "GET", body, token } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

test("web de reservas: rutas públicas y configuración", async (t) => {
  const db = createFakeDb();
  const originalQuery = pool.query.bind(pool);
  pool.query = db.query;

  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  });

  const admin = signTokenFor({ role: "admin", tenant_id: TENANT_A }).token;
  const staff = signTokenFor({ role: "staff", tenant_id: TENANT_A }).token;

  await t.test("un slug que no existe devuelve 404 sin pedir login", async () => {
    const { status } = await request(baseUrl, "/public/booking/no-existe");
    assert.equal(status, 404);
  });

  await t.test("staff no puede ver ni tocar la configuración", async () => {
    assert.equal((await request(baseUrl, "/v2/booking/settings", { token: staff })).status, 403);
    assert.equal((await request(baseUrl, "/v2/booking/settings", { method: "PUT", token: staff, body: { enabled: true } })).status, 403);
  });

  await t.test("sin configuración guardada devuelve valores por defecto y sugiere el link", async () => {
    const { status, body } = await request(baseUrl, "/v2/booking/settings", { token: admin });
    assert.equal(status, 200);
    assert.equal(body.settings.enabled, false);
    assert.equal(body.settings.capacity, 1);
    assert.equal(body.suggested_slug, "peluqueria-bandidos");
  });

  await t.test("no se puede prender la web sin elegir un link", async () => {
    const { status } = await request(baseUrl, "/v2/booking/settings", { method: "PUT", token: admin, body: { enabled: true } });
    assert.equal(status, 400);
  });

  await t.test("un link que ya usa otro local devuelve 409", async () => {
    const { status } = await request(baseUrl, "/v2/booking/settings", {
      method: "PUT", token: admin, body: { slug: "otro-local" }
    });
    assert.equal(status, 409);
  });

  await t.test("guarda la configuración y la devuelve", async () => {
    const { status, body } = await request(baseUrl, "/v2/booking/settings", {
      method: "PUT",
      token: admin,
      body: { enabled: false, slug: "Bandidos", address: "Av. Siempre Viva 123", min_notice_minutes: 0, capacity: 1 }
    });
    assert.equal(status, 200);
    assert.equal(body.settings.slug, "bandidos");
    assert.equal(body.settings.address, "Av. Siempre Viva 123");
  });

  await t.test("con la web apagada, la portada solo muestra datos de contacto", async () => {
    const { status, body } = await request(baseUrl, "/public/booking/bandidos");
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.business.name, "Peluquería Bandidos");
    assert.equal(body.services, undefined);
  });

  await t.test("con la web apagada no se consulta disponibilidad", async () => {
    const { status } = await request(baseUrl, `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}`);
    assert.equal(status, 404);
  });

  await t.test("prendida, la portada lista solo los servicios publicados, con precio por tamaño", async () => {
    await request(baseUrl, "/v2/booking/settings", { method: "PUT", token: admin, body: { enabled: true } });
    const { status, body } = await request(baseUrl, "/public/booking/bandidos");
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.deepEqual(body.services.map((s) => s.name), ["Baño"]);
    const bano = body.services[0];
    assert.equal(bano.price_from, 15000);
    assert.deepEqual(bano.sizes.grande, { price: 22000, duration: 90 });
    assert.deepEqual(bano.sizes.chico, { price: 15000, duration: 60 });
    assert.equal(body.hours.length, 7);
  });

  await t.test("el equipo ve el link público para compartirlo", async () => {
    const { status, body } = await request(baseUrl, "/v2/booking/link", { token: staff });
    assert.equal(status, 200);
    assert.deepEqual(body, { slug: "bandidos", enabled: true });
  });

  await t.test("disponibilidad: descuenta el turno reservado e ignora cancelados y otros locales", async () => {
    const { status, body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&size=chico&from=${TARGET}&days=1`
    );
    assert.equal(status, 200);
    assert.equal(body.price, 15000);
    assert.equal(body.duration, 60);
    assert.deepEqual(body.days, [{ date: TARGET, slots: ["09:00", "11:00"] }]);
  });

  await t.test("disponibilidad sin tamaño: reserva la duración más larga y no fija precio", async () => {
    const { body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&from=${TARGET}&days=1`
    );
    assert.equal(body.size, null);
    assert.equal(body.price, null);
    assert.equal(body.duration, 90);
  });

  await t.test("disponibilidad: el tamaño grande dura 90 minutos y deja menos horarios", async () => {
    const { body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&size=grande&from=${TARGET}&days=1`
    );
    assert.equal(body.duration, 90);
    // 09:00-10:30 pisa el turno de las 10; 11:00-12:30 se pasa del cierre.
    assert.deepEqual(body.days[0].slots, []);
  });

  await t.test("disponibilidad: un día cerrado no ofrece horarios", async () => {
    const created = await request(baseUrl, "/v2/booking/closed-days", {
      method: "POST", token: admin, body: { date: TARGET, reason: "Feriado" }
    });
    assert.equal(created.status, 201);
    const { body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&from=${TARGET}&days=1`
    );
    assert.deepEqual(body.days[0].slots, []);
    db.closedDays.length = 0;
  });

  await t.test("disponibilidad: un servicio no publicado o de otro local da 404", async () => {
    const hidden = await request(baseUrl, `/public/booking/bandidos/availability?service_type_id=${SERVICE_HIDDEN}`);
    assert.equal(hidden.status, 404);
    const foreign = await request(baseUrl, `/public/booking/bandidos/availability?service_type_id=${SERVICE_OTHER_TENANT}`);
    assert.equal(foreign.status, 404);
  });

  await t.test("disponibilidad: todas las consultas van con el tenant del slug", async () => {
    db.queries.length = 0;
    await request(baseUrl, `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&from=${TARGET}&days=3`);
    const scoped = db.queries.filter((x) => /from (booking_hours|booking_closed_days|agenda_turnos|agenda_blocks)/.test(x.q));
    assert.equal(scoped.length, 4);
    for (const x of scoped) assert.equal(x.params[0], TENANT_A);
  });

  await t.test("disponibilidad: no pasa de la anticipación máxima", async () => {
    const { body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&from=${addDays(argentinaNow().date, 29)}&days=10`
    );
    // Hoy + 30 días es el último día permitido: quedan 2 días (29 y 30).
    assert.equal(body.days.length, 2);
    assert.equal(weekdayOf(body.days[0].date), weekdayOf(addDays(argentinaNow().date, 29)));
  });

  await t.test("un bloqueo cargado desde la agenda saca esos horarios de la web", async () => {
    const staffBlock = await request(baseUrl, "/v2/agenda/blocks", {
      method: "POST", token: staff, body: { date: TARGET, start_time: "08:30", end_time: "09:30", reason: "Trámite" }
    });
    assert.equal(staffBlock.status, 201);
    assert.equal(staffBlock.body.start_time, "08:30");

    const listed = await request(baseUrl, `/v2/agenda/blocks?from=${TARGET}&to=${TARGET}`, { token: staff });
    assert.equal(listed.body.length, 1);

    const { body } = await request(
      baseUrl,
      `/public/booking/bandidos/availability?service_type_id=${SERVICE_ONLINE}&size=chico&from=${TARGET}&days=1`
    );
    assert.deepEqual(body.days[0].slots, ["11:00"]);

    // Otro local no puede borrarlo.
    const otherAdmin = signTokenFor({ role: "admin", tenant_id: TENANT_B }).token;
    const foreign = await request(baseUrl, `/v2/agenda/blocks/${staffBlock.body.id}`, { method: "DELETE", token: otherAdmin });
    assert.equal(foreign.status, 404);

    const removed = await request(baseUrl, `/v2/agenda/blocks/${staffBlock.body.id}`, { method: "DELETE", token: staff });
    assert.equal(removed.status, 200);
    assert.equal(db.blocks.length, 0);
  });

  await t.test("un bloqueo con la hora de fin antes que la de inicio se rechaza", async () => {
    const { status } = await request(baseUrl, "/v2/agenda/blocks", {
      method: "POST", token: staff, body: { date: TARGET, start_time: "12:00", end_time: "10:00" }
    });
    assert.equal(status, 400);
  });

  await t.test("reserva: rechaza datos inválidos, la política sin aceptar y el campo trampa", async () => {
    const valid = {
      service_type_id: SERVICE_ONLINE, size: "chico", date: TARGET, time: "09:00",
      owner_name: "Juana", phone: "381 555-1234", pet_name: "Rocco", accept_policy: true
    };
    const post = (body) => request(baseUrl, "/public/booking/bandidos/reservations", { method: "POST", body });
    assert.equal((await post({ ...valid, accept_policy: false })).status, 400);
    assert.equal((await post({ ...valid, phone: "--" })).status, 400);
    assert.equal((await post({ ...valid, website: "spam" })).status, 400);
    assert.equal((await post({ ...valid, time: "9" })).status, 400);
  });

  await t.test("reserva: un link inexistente da 404 y un código de turno mal formado también", async () => {
    const { status } = await request(baseUrl, "/public/booking/no-existe/reservations", {
      method: "POST",
      body: {
        service_type_id: SERVICE_ONLINE, size: "chico", date: TARGET, time: "09:00",
        owner_name: "Juana", phone: "381 555-1234", pet_name: "Rocco", accept_policy: true
      }
    });
    assert.equal(status, 404);
    const lookup = await request(baseUrl, "/public/booking/bandidos/reservations/no-es-un-token");
    assert.equal(lookup.status, 404);
  });

  await t.test("disponibilidad: rechaza parámetros inválidos", async () => {
    const { status } = await request(baseUrl, "/public/booking/bandidos/availability?service_type_id=nope");
    assert.equal(status, 400);
  });
});
