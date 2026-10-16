import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTrasladosDb } from "./helpers/trasladosDb.js";
import { signTokenFor } from "./helpers/authRevalidation.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";
const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const A = crypto.randomUUID(),
  B = crypto.randomUUID();
const DATE = "2026-10-16";
const requestData = (extra = {}) => ({
  date: DATE,
  time: "10:00",
  pet_name: "Luna",
  owner_name: "Ana",
  traslado: true,
  ...extra,
});
const solicitudData = (extra = {}) => ({
  precio_total: 8000,
  bonificado: false,
  tramos: [{ tipo: "busqueda" }, { tipo: "entrega" }],
  ...extra,
});

test("registros de traslados en PostgreSQL", async (t) => {
  const originalQuery = pool.query,
    originalConnect = pool.connect;
  const pg = await createTrasladosDb();
  pool.query = pg.query;
  pool.connect = pg.connect;
  await pg.query("INSERT INTO tenants(id) VALUES($1),($2)", [A, B]);
  const tokens = {};
  const userIds = {};
  for (const [name, role, tenant] of [
    ["a", "admin", A],
    ["b", "admin", B],
    ["staff", "staff", A],
  ]) {
    const { token, sub } = signTokenFor({ role, tenant_id: tenant });
    tokens[name] = token;
    userIds[name] = sub;
    await pg.query("INSERT INTO users(id,tenant_id) VALUES($1,$2)", [
      sub,
      tenant,
    ]);
  }
  const pm = crypto.randomUUID(),
    pmB = crypto.randomUUID();
  await pg.query(
    "INSERT INTO payment_methods(id,tenant_id,name) VALUES($1,$2,'Efectivo'),($3,$4,'Transferencia')",
    [pm, A, pmB, B],
  );
  const server = app.listen(0);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await pg.close();
  });
  const request = async (path, method = "GET", body, token = tokens.a) => {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const json = await res.json();
    return { status: res.status, body: json };
  };
  const create = async (extra = {}) => {
    const result = await request(
      "/agenda",
      "POST",
      requestData({ traslado_solicitud: solicitudData(), ...extra }),
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const operations = await request(
      `/v2/traslado-solicitudes?turno_id=${result.body.id}`,
    );
    assert.equal(operations.body.length, 1);
    return { turno: result.body, solicitud: operations.body[0] };
  };
  let vehicle, zone, driver, config;
  await t.test(
    "vehículos y zonas: CRUD, validación, permisos y aislamiento",
    async () => {
      for (const [path, input] of [
        ["vehiculos", { nombre: "Bandimóvil 1", patente: "ab123cd" }],
        ["traslado-zonas", { nombre: "Centro", tarifa: 7000 }],
      ]) {
        assert.equal(
          (await request(`/v2/${path}`, "POST", input, tokens.staff)).status,
          403,
        );
        assert.equal(
          (await request(`/v2/${path}`, "POST", { ...input, tenant_id: B }))
            .status,
          400,
        );
        const made = await request(`/v2/${path}`, "POST", input);
        assert.equal(made.status, 201, JSON.stringify(made.body));
        if (path === "vehiculos") vehicle = made.body;
        else zone = made.body;
        const itemPath = `/v2/${path}/${made.body.id}`;
        assert.equal((await request(itemPath)).status, 200);
        assert.deepEqual(
          (await request(`/v2/${path}`, "GET", undefined, tokens.b)).body,
          [],
        );
        for (const method of ["GET", "PUT", "DELETE"])
          assert.equal(
            (
              await request(
                itemPath,
                method,
                method === "PUT" ? { nombre: "Ajeno" } : undefined,
                tokens.b,
              )
            ).status,
            404,
          );
        assert.equal(
          (await request(itemPath, "PUT", { nombre: "Actualizado" })).status,
          200,
        );
        assert.equal((await request(itemPath, "DELETE")).body.activo, false);
        assert.equal(
          (await request(itemPath, "PUT", { activo: true })).body.activo,
          true,
        );
      }
    },
  );
  await t.test(
    "socios como choferes sin cuenta de usuario ni rol Groomer",
    async () => {
      const made = await request("/v2/employees", "POST", {
        name: "Jorge",
        role: "Socio",
        status: "active",
        is_driver: true,
      });
      assert.equal(made.status, 201);
      driver = made.body;
      assert.equal(driver.is_driver, true);
      assert.equal(driver.role, "Socio");
      assert.equal(
        (
          await request(
            `/v2/employees/${driver.id}`,
            "PUT",
            { is_driver: false },
            tokens.b,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(`/v2/employees/${driver.id}`, "PUT", {
            is_driver: false,
          })
        ).body.is_driver,
        false,
      );
      await request(`/v2/employees/${driver.id}`, "PUT", { is_driver: true });
    },
  );
  await t.test(
    "configuración versionada, sin costos inventados ni alteraciones retroactivas",
    async () => {
      assert.equal((await request("/v2/traslados/configuracion")).body, null);
      const value = {
        modelo_pago: "porcentaje",
        valor_pago: 100,
        costo_referencia: null,
        unidad_referencia: null,
      };
      assert.equal(
        (
          await request(
            "/v2/traslados/configuracion",
            "PUT",
            value,
            tokens.staff,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/v2/traslados/configuracion", "PUT", {
            ...value,
            valor_pago: 101,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/v2/traslados/configuracion", "PUT", {
            ...value,
            costo_referencia: 40000,
          })
        ).status,
        400,
      );
      config = (await request("/v2/traslados/configuracion", "PUT", value))
        .body;
      assert.equal(config.version, 1);
      assert.equal(
        (
          await request(
            "/v2/traslados/configuracion",
            "GET",
            undefined,
            tokens.b,
          )
        ).body,
        null,
      );
      const { solicitud } = await create();
      assert.equal(solicitud.configuracion_id, config.id);
      await request("/v2/traslados/configuracion", "PUT", {
        modelo_pago: "jornal",
        valor_pago: 40000,
        costo_referencia: 40000,
        unidad_referencia: "dia",
      });
      assert.equal(
        (await request(`/v2/traslado-solicitudes/${solicitud.id}`)).body
          .configuracion_id,
        config.id,
      );
      assert.equal(
        Number(
          (
            await pg.query(
              "SELECT valor_pago FROM traslado_configuracion WHERE id=$1",
              [config.id],
            )
          ).rows[0].valor_pago,
        ),
        100,
      );
    },
  );
  await t.test(
    "Agenda crea una sola operación con dos tramos y no crea un cobro",
    async () => {
      const { turno, solicitud } = await create();
      assert.equal(solicitud.tramos.length, 2);
      assert.equal(Number(solicitud.precio_total), 8000);
      assert.equal(solicitud.cobro, null);
      for (let i = 0; i < 2; i++) {
        const closed = await request(`/agenda/${turno.id}`, "PUT", {
          status: "finished",
        });
        assert.equal(closed.status, 200, JSON.stringify(closed.body));
      }
      const list = (
        await request(`/v2/traslado-solicitudes?turno_id=${turno.id}`)
      ).body;
      assert.equal(list.length, 1);
      assert.equal(list[0].tramos.length, 2);
      assert.equal(list[0].cobro, null);
      assert.equal(
        Number(
          (
            await pg.query(
              "SELECT traslado_amount FROM agenda_turnos WHERE id=$1",
              [turno.id],
            )
          ).rows[0].traslado_amount,
        ),
        8000,
      );
    },
  );
  await t.test(
    "altas con nueva mascota y cliente son atómicas con sus tramos",
    async () => {
      const made = await request(
        "/v2/agenda/with-new-pet",
        "POST",
        requestData({ traslado_solicitud: solicitudData() }),
      );
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(
        (await request(`/v2/traslado-solicitudes?turno_id=${made.body.id}`))
          .body[0].tramos.length,
        2,
      );
      const before = Number(
        (await pg.query("SELECT count(*) FROM customers")).rows[0].count,
      );
      const invalid = await request(
        "/v2/agenda/with-new-pet",
        "POST",
        requestData({
          traslado_solicitud: solicitudData({
            tramos: [{ tipo: "busqueda", vehiculo_id: crypto.randomUUID() }],
          }),
        }),
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        Number(
          (await pg.query("SELECT count(*) FROM customers")).rows[0].count,
        ),
        before,
      );
    },
  );
  await t.test(
    "precio pendiente es NULL; bonificación explícita es cero sin cobro",
    async () => {
      const { turno, solicitud } = await create({
        traslado_solicitud: solicitudData({ precio_total: null }),
      });
      assert.equal(solicitud.precio_total, null);
      assert.equal(
        (await request(`/agenda/${turno.id}`, "PUT", { status: "finished" }))
          .status,
        400,
      );
      assert.equal(
        (
          await request(
            `/v2/traslado-solicitudes/${solicitud.id}`,
            "PUT",
            solicitudData({ precio_total: 0, bonificado: false }),
          )
        ).status,
        400,
      );
      const saved = await request(
        `/v2/traslado-solicitudes/${solicitud.id}`,
        "PUT",
        solicitudData({ precio_total: 0, bonificado: true }),
      );
      assert.equal(saved.status, 200);
      assert.equal(saved.body.bonificado, true);
      assert.equal(Number(saved.body.precio_total), 0);
      assert.equal(
        (await request(`/agenda/${turno.id}`, "PUT", { status: "finished" }))
          .status,
        200,
      );
      assert.equal(
        (
          await request(
            `/v2/traslado-solicitudes/${solicitud.id}/cobro`,
            "POST",
            {
              fecha: DATE,
              cobrado_por: "local",
              chofer_id: null,
              payment_method_id: pm,
            },
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "referencias del mismo local en API y FK; errores revierten el alta",
    async () => {
      const foreign = (
        await request(
          "/v2/vehiculos",
          "POST",
          { nombre: "Ajeno", patente: "XX999" },
          tokens.b,
        )
      ).body;
      const before = Number(
        (await pg.query("SELECT count(*) FROM agenda_turnos")).rows[0].count,
      );
      const result = await request(
        "/agenda",
        "POST",
        requestData({
          traslado_solicitud: solicitudData({
            tramos: [{ tipo: "busqueda", vehiculo_id: foreign.id }],
          }),
        }),
      );
      assert.equal(result.status, 400);
      assert.equal(
        Number(
          (await pg.query("SELECT count(*) FROM agenda_turnos")).rows[0].count,
        ),
        before,
      );
      const { solicitud } = await create();
      await assert.rejects(
        pg.query(
          "UPDATE traslados SET vehiculo_id=$1 WHERE tenant_id=$2 AND solicitud_id=$3",
          [foreign.id, A, solicitud.id],
        ),
        (e) => e.code === "23503",
      );
      assert.equal(
        (
          await request(
            `/v2/traslado-solicitudes/${solicitud.id}`,
            "PUT",
            solicitudData(),
            tokens.b,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            `/v2/traslados/${solicitud.tramos[0].id}`,
            "PUT",
            { tipo: solicitud.tramos[0].tipo },
            tokens.b,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "/v2/traslados",
            "POST",
            { solicitud_id: solicitud.id, tramo: { tipo: "busqueda" } },
            tokens.b,
          )
        ).status,
        404,
      );
      for (const path of [
        `/v2/traslado-solicitudes/${solicitud.id}`,
        `/v2/traslados/${solicitud.tramos[0].id}`,
      ]) {
        assert.equal(
          (await request(path, "GET", undefined, tokens.b)).status,
          404,
        );
        assert.equal(
          (await request(path, "DELETE", undefined, tokens.b)).status,
          404,
        );
      }
    },
  );
  await t.test(
    "CRUD de tramos conserva importe único y respeta estados y filtros",
    async () => {
      const { turno, solicitud } = await create({
        traslado_solicitud: solicitudData({ tramos: [{ tipo: "busqueda" }] }),
      });
      const added = await request("/v2/traslados", "POST", {
        solicitud_id: solicitud.id,
        tramo: { tipo: "entrega" },
      });
      assert.equal(added.status, 200);
      let trip = added.body.tramos.find((r) => r.tipo === "busqueda");
      const path = `/v2/traslados/${trip.id}`;
      assert.equal((await request(path)).status, 200);
      assert.equal(
        (await request(path, "PUT", { tipo: "busqueda", estado: "entregado" }))
          .status,
        409,
      );
      assert.equal(
        (await request(path, "PUT", { tipo: "busqueda", estado: "en_camino" }))
          .status,
        400,
      );
      const input = {
        tipo: "busqueda",
        chofer_id: driver.id,
        vehiculo_id: vehicle.id,
        zona_id: zone.id,
        direccion: "San Martín 100",
        fecha_programada: DATE,
        hora_programada: "09:00",
        estado: "en_camino",
      };
      assert.equal((await request(path, "PUT", input)).status, 200);
      const filtered = await request(
        `/v2/traslados?from=${DATE}&to=${DATE}&chofer_id=${driver.id}&vehiculo_id=${vehicle.id}&turno_id=${turno.id}`,
      );
      assert.equal(filtered.body.length, 1);
      assert.deepEqual(
        (
          await request(
            `/v2/traslados?turno_id=${turno.id}`,
            "GET",
            undefined,
            tokens.b,
          )
        ).body,
        [],
      );
      assert.equal((await request(path, "DELETE")).status, 200);
      assert.equal(
        Number(
          (await request(`/v2/traslado-solicitudes/${solicitud.id}`)).body
            .precio_total,
        ),
        8000,
      );
      trip = added.body.tramos.find((r) => r.tipo === "entrega");
      assert.equal(
        (await request(`/v2/traslados/${trip.id}`, "DELETE")).body.cancelado,
        true,
      );
    },
  );
  await t.test(
    "cobro explícito único, fecha y medio propios; reintentos y concurrencia",
    async () => {
      const { solicitud } = await create();
      const path = `/v2/traslado-solicitudes/${solicitud.id}/cobro`;
      const input = {
        fecha: "2026-10-17",
        cobrado_por: "local",
        chofer_id: null,
        payment_method_id: pm,
      };
      assert.equal(
        (await request(path, "POST", { ...input, payment_method_id: pmB }))
          .status,
        400,
      );
      assert.equal((await request(path, "POST", input, tokens.b)).status, 404);
      const results = await Promise.all([
        request(path, "POST", input),
        request(path, "POST", input),
      ]);
      for (const r of results) {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(Number(r.body.monto), 8000);
      }
      assert.equal(results[0].body.id, results[1].body.id);
      assert.equal(
        (await request(path, "POST", { ...input, fecha: DATE })).status,
        409,
      );
      assert.equal(
        (
          await request(
            `/v2/traslado-solicitudes/${solicitud.id}`,
            "PUT",
            solicitudData({ precio_total: 9000 }),
          )
        ).status,
        409,
      );
      assert.equal(
        (await request(`/v2/traslado-solicitudes/${solicitud.id}`, "DELETE"))
          .status,
        409,
      );
      assert.equal(
        (
          await request("/v2/daily-incomes/system-totals?date=2026-10-17")
        ).body.find((r) => r.concept === "traslados").amount,
        8000,
      );
      assert.equal(
        (await request("/v2/daily-incomes/traslados-summary?date=2026-10-17"))
          .body.amount,
        0,
      );
      assert.equal(
        (
          await request(
            "/v2/traslado-solicitudes/cobrados?from=2026-10-17&to=2026-10-17",
          )
        ).body.amount,
        8000,
      );
      assert.equal(
        (
          await request(
            "/v2/daily-incomes/system-totals?date=2026-10-17",
            "GET",
            undefined,
            tokens.b,
          )
        ).body.length,
        0,
      );
    },
  );
  await t.test(
    "cobro de chofer nunca entra a caja; no duplica legado ni precio pactado",
    async () => {
      const { solicitud } = await create();
      const input = {
        fecha: "2026-10-18",
        cobrado_por: "chofer",
        chofer_id: driver.id,
        payment_method_id: pm,
      };
      assert.equal(
        (
          await request(
            `/v2/traslado-solicitudes/${solicitud.id}/cobro`,
            "POST",
            input,
            tokens.staff,
          )
        ).status,
        200,
      );
      const cash = await request(
        "/v2/daily-incomes/system-totals?date=2026-10-18",
      );
      assert.equal(
        cash.body.some((r) => r.concept === "traslados"),
        false,
      );
      assert.equal(
        (await request("/v2/daily-incomes/traslados-summary?date=2026-10-18"))
          .body.amount,
        8000,
      );
      assert.equal(
        (await request(`/v2/employees/${driver.id}`, "DELETE")).status,
        409,
      );
    },
  );
  await t.test("el responsable de un cobro no se borra ni queda sin historia", async () => {
    assert.equal((await request(`/v2/users/${userIds.a}`, "DELETE", undefined, tokens.b)).status, 404);
    assert.equal((await request(`/v2/users/${userIds.a}`, "DELETE")).status, 409);
  });
  await t.test(
    "legacy no se importa ni reclasifica; se cuenta una sola vez y solo en su local",
    async () => {
      const result = await pg.query(
        "INSERT INTO agenda_turnos(tenant_id,date,time,pet_name,status,traslado,traslado_amount) VALUES($1,'2026-09-01','09:00','Histórico','finished',true,5000) RETURNING *",
        [A],
      );
      const old = result.rows[0];
      assert.equal(
        (await request(`/agenda/${old.id}`, "PUT", { notes: "Corregido" }))
          .status,
        200,
      );
      assert.deepEqual(
        (await request(`/v2/traslado-solicitudes?turno_id=${old.id}`)).body,
        [],
      );
      assert.equal(
        (
          await request(`/agenda/${old.id}`, "PUT", {
            traslado_solicitud: solicitudData(),
          })
        ).status,
        409,
      );
      assert.equal(
        (await request("/v2/daily-incomes/traslados-summary?date=2026-09-01"))
          .body.amount,
        5000,
      );
      assert.equal(
        (
          await request(
            "/v2/traslado-solicitudes/cobrados?from=2026-09-01&to=2026-09-01",
          )
        ).body.amount,
        5000,
      );
      assert.equal(
        (
          await request(
            "/v2/daily-incomes/traslados-summary?date=2026-09-01",
            "GET",
            undefined,
            tokens.b,
          )
        ).body.amount,
        0,
      );
    },
  );
  await t.test(
    "solicitudes CRUD y cancelación del turno conservan historia",
    async () => {
      const turn = await request(
        "/agenda",
        "POST",
        requestData({ traslado: false }),
      );
      const payload = { turno_id: turn.body.id, solicitud: solicitudData() };
      assert.equal(
        (await request("/v2/traslado-solicitudes", "POST", payload, tokens.b))
          .status,
        404,
      );
      const made = await request("/v2/traslado-solicitudes", "POST", payload);
      assert.equal(made.status, 201);
      assert.equal(
        (await request("/v2/traslado-solicitudes", "POST", payload)).body.id,
        made.body.id,
      );
      assert.equal(
        (await request(`/agenda/${turn.body.id}`, "DELETE")).status,
        409,
      );
      assert.equal(
        (
          await request(`/agenda/${turn.body.id}`, "PUT", {
            status: "cancelled",
          })
        ).status,
        200,
      );
      const record = (await request(`/v2/traslado-solicitudes/${made.body.id}`))
        .body;
      assert.equal(record.cancelado, true);
      assert.ok(record.tramos.every((r) => r.estado === "cancelado"));
      assert.equal(
        (
          await request(`/agenda/${turn.body.id}`, "PUT", {
            status: "reserved",
            traslado: true,
            traslado_amount: 8000,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await pg.query("SELECT traslado FROM agenda_turnos WHERE id=$1", [
            turn.body.id,
          ])
        ).rows[0].traslado,
        false,
      );
    },
  );
  await t.test(
    "la migración conserva filas anteriores y bloquea inconsistencias aun por SQL",
    async () => {
      const original = (
        await pg.query("SELECT * FROM agenda_turnos WHERE pet_name='Histórico'")
      ).rows[0];
      await pg.db.exec(
        await readFile(
          new URL(
            "../db/migrations/025_traslados_registros.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await pg.query("SELECT * FROM agenda_turnos WHERE id=$1", [
            original.id,
          ])
        ).rows[0],
        original,
      );
      assert.equal(original.traslado_bonificado, null);
      assert.equal(Number(original.traslado_amount), 5000);
      await assert.rejects(
        pg.query(
          "INSERT INTO traslado_configuracion(tenant_id,version,modelo_pago,valor_pago) VALUES($1,999,'porcentaje',NULL)",
          [A],
        ),
        (e) => e.code === "23514",
      );
      const operation = await create();
      await assert.rejects(
        pg.query(
          "UPDATE traslado_solicitudes SET precio_total=0,bonificado=false WHERE tenant_id=$1 AND id=$2",
          [A, operation.solicitud.id],
        ),
        (e) => e.code === "23514",
      );
      assert.equal(
        (
          await request(
            "/agenda",
            "POST",
            requestData({
              status: "cancelled",
              traslado_solicitud: solicitudData(),
            }),
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "todas las rutas nuevas requieren autenticación y validan parámetros",
    async () => {
      for (const path of [
        "/v2/vehiculos",
        "/v2/traslado-zonas",
        "/v2/traslados",
        "/v2/traslado-solicitudes",
        "/v2/traslados/configuracion",
      ])
        assert.equal((await request(path, "GET", undefined, null)).status, 401);
      assert.equal(
        (await request("/v2/traslados?from=2026-99-99")).status,
        400,
      );
      assert.equal(
        (
          await request(
            "/v2/traslado-solicitudes/cobrados?from=2026-10-20&to=2026-10-01",
          )
        ).status,
        400,
      );
    },
  );
});
