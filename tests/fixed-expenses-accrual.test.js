// Tests del cálculo de devengamiento. No tocan base ni HTTP: importan la
// lógica pura de src/fixedExpenses.js.
//
// Lo que se protege acá es la invariante que hace confiable el dashboard:
// la suma de la serie diaria tiene que dar EXACTAMENTE el total del período.
// Si eso se rompe, el KPI y el gráfico dejan de coincidir y no hay forma de
// que el dueño entienda por qué.
import assert from "node:assert/strict";
import test from "node:test";

const { buildAccrual, eachDate, toDateKey, previousPeriodDate, periodToDate, periodSchema } =
  await import("../src/fixedExpenses.js");

// Construye un cargo como lo devuelve fetchChargesForRange.
function cargo({
  id = "c1",
  name = "Alquiler",
  period,
  amount,
  daysInMonth,
  daysInRange,
  paidAt = null,
  categoryId = "cat-1",
  categoryName = "Alquiler"
}) {
  return {
    id,
    fixed_expense_id: `fe-${id}`,
    period,
    due_date: `${period.slice(0, 8)}05`,
    amount: String(amount),
    paid_at: paidAt,
    paid_amount: null,
    name,
    category_id: categoryId,
    category_name: categoryName,
    days_in_month: daysInMonth,
    days_in_range: daysInRange
  };
}

// La comparación va en CENTAVOS enteros a propósito. Los valores diarios son
// exactos al centavo, pero sumar treinta y pico de floats arrastra el error de
// IEEE754 (0.01 repetido 100 veces no da 1). Sumar en enteros afirma lo que
// realmente importa — que los centavos cierran — sin pedirle a los floats algo
// que no pueden dar.
const centavos = (valor) => Math.round(valor * 100);
const sumarDias = (accrual) =>
  accrual.by_day.reduce((total, dia) => total + centavos(dia.amount), 0);

test("devengamiento de gastos fijos", async (t) => {
  await t.test("un mes completo devenga el monto entero", () => {
    const accrual = buildAccrual(
      [cargo({ period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 31 })],
      "2026-08-01",
      "2026-08-31"
    );
    assert.equal(accrual.accrued_total, 180000);
    assert.equal(accrual.by_day.length, 31);
  });

  await t.test("un solo día devenga la parte proporcional", () => {
    const accrual = buildAccrual(
      [cargo({ period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 1 })],
      "2026-08-18",
      "2026-08-18"
    );
    // 180000 / 31 = 5806.4516...
    assert.equal(accrual.accrued_total, 5806.45);
    assert.equal(accrual.by_day.length, 1);
  });

  await t.test("un rango de tres meses devenga los tres cargos", () => {
    const accrual = buildAccrual(
      [
        cargo({ id: "a", period: "2026-06-01", amount: 100000, daysInMonth: 30, daysInRange: 30 }),
        cargo({ id: "b", period: "2026-07-01", amount: 100000, daysInMonth: 31, daysInRange: 31 }),
        cargo({ id: "c", period: "2026-08-01", amount: 120000, daysInMonth: 31, daysInRange: 31 })
      ],
      "2026-06-01",
      "2026-08-31"
    );
    assert.equal(accrual.accrued_total, 320000);
  });

  // La razón de ser del reparto de centavos: redondear cada día por separado
  // acumulaba una deriva que despegaba el gráfico del KPI.
  await t.test("la suma de by_day da exactamente el total, con montos indivisibles", () => {
    for (const [amount, daysInMonth] of [
      [100, 31],      // 3.2258... por día
      [180000, 31],
      [1, 28],        // un centavo repartido en 28 días
      [999999.99, 30],
      [2909272, 31]   // total mensual real de producción
    ]) {
      const period = daysInMonth === 28 ? "2026-02-01" : "2026-08-01";
      const accrual = buildAccrual(
        [cargo({ period, amount, daysInMonth, daysInRange: daysInMonth })],
        period,
        `${period.slice(0, 8)}${daysInMonth}`
      );
      assert.equal(
        sumarDias(accrual),
        centavos(accrual.accrued_total),
        `by_day no cierra con el KPI para ${amount} en ${daysInMonth} días`
      );
    }
  });

  await t.test("la suma cierra también con varios cargos y varios meses", () => {
    const accrual = buildAccrual(
      [
        cargo({ id: "a", period: "2026-07-01", amount: 180000, daysInMonth: 31, daysInRange: 31 }),
        cargo({ id: "b", period: "2026-07-01", amount: 9500, daysInMonth: 31, daysInRange: 31 }),
        cargo({ id: "c", period: "2026-07-01", amount: 45000.33, daysInMonth: 31, daysInRange: 31 }),
        cargo({ id: "d", period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 18 })
      ],
      "2026-07-01",
      "2026-08-18"
    );
    assert.equal(sumarDias(accrual), centavos(accrual.accrued_total));
  });

  await t.test("agrupa por categoría", () => {
    const accrual = buildAccrual(
      [
        cargo({ id: "a", period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 31,
                categoryId: "alq", categoryName: "Alquiler" }),
        cargo({ id: "b", period: "2026-08-01", amount: 9500, daysInMonth: 31, daysInRange: 31,
                categoryId: "srv", categoryName: "Servicios" }),
        cargo({ id: "c", period: "2026-08-01", amount: 12000, daysInMonth: 31, daysInRange: 31,
                categoryId: "srv", categoryName: "Servicios" })
      ],
      "2026-08-01",
      "2026-08-31"
    );
    assert.deepEqual(
      accrual.by_category.map((c) => [c.name, c.accrued]),
      [["Alquiler", 180000], ["Servicios", 21500]]
    );
  });

  await t.test("los impagos suman el mes completo, no lo prorrateado", () => {
    const accrual = buildAccrual(
      [
        cargo({ id: "a", period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 10 }),
        cargo({ id: "b", period: "2026-08-01", amount: 9500, daysInMonth: 31, daysInRange: 10,
                paidAt: "2026-08-05" })
      ],
      "2026-08-01",
      "2026-08-10"
    );
    assert.equal(accrual.unpaid.count, 1);
    assert.equal(accrual.unpaid.total, 180000);
  });

  // El run-rate contesta "¿cuánto cuesta un mes?", el devengado contesta
  // "¿cuánto le toca a este rango?". Confundirlos fue el bug original.
  await t.test("el run-rate mensual es distinto del devengado del rango", () => {
    const accrual = buildAccrual(
      [cargo({ period: "2026-08-01", amount: 180000, daysInMonth: 31, daysInRange: 10 })],
      "2026-08-01",
      "2026-08-10"
    );
    assert.equal(accrual.monthly_total, 180000);
    assert.notEqual(accrual.accrued_total, accrual.monthly_total);
  });

  await t.test("sin cargos devenga cero sin romperse", () => {
    const accrual = buildAccrual([], "2026-08-01", "2026-08-31");
    assert.equal(accrual.accrued_total, 0);
    assert.equal(accrual.monthly_total, 0);
    assert.deepEqual(accrual.by_category, []);
    assert.equal(accrual.by_day.length, 31);
    assert.equal(sumarDias(accrual), 0);
  });
});

test("helpers de fechas", async (t) => {
  await t.test("eachDate cubre el rango inclusive", () => {
    assert.deepEqual(eachDate("2026-08-01", "2026-08-03"),
      ["2026-08-01", "2026-08-02", "2026-08-03"]);
    assert.deepEqual(eachDate("2026-08-05", "2026-08-05"), ["2026-08-05"]);
  });

  await t.test("eachDate cruza el fin de mes y el fin de año", () => {
    assert.deepEqual(eachDate("2026-02-27", "2026-03-01"),
      ["2026-02-27", "2026-02-28", "2026-03-01"]);
    assert.deepEqual(eachDate("2026-12-31", "2027-01-01"),
      ["2026-12-31", "2027-01-01"]);
  });

  await t.test("previousPeriodDate retrocede un mes, incluso en enero", () => {
    assert.equal(previousPeriodDate("2026-09-01"), "2026-08-01");
    assert.equal(previousPeriodDate("2026-01-01"), "2025-12-01");
    assert.equal(previousPeriodDate("2026-03-01"), "2026-02-01");
  });

  await t.test("toDateKey normaliza Date y string a YYYY-MM-DD", () => {
    assert.equal(toDateKey(new Date("2026-08-18T00:00:00Z")), "2026-08-18");
    assert.equal(toDateKey("2026-08-18"), "2026-08-18");
    assert.equal(toDateKey("2026-08-18T12:34:56.000Z"), "2026-08-18");
  });

  await t.test("periodToDate y periodSchema", () => {
    assert.equal(periodToDate("2026-09"), "2026-09-01");
    assert.equal(periodSchema.safeParse("2026-09").success, true);
    assert.equal(periodSchema.safeParse("2026-9").success, false);
    assert.equal(periodSchema.safeParse("2026-09-01").success, false);
    assert.equal(periodSchema.safeParse("").success, false);
  });
});
