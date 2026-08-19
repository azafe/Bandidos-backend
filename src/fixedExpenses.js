// src/fixedExpenses.js
//
// Lógica pura del devengamiento de gastos fijos: sin acceso a base ni a HTTP,
// para poder testearla sin levantar la app. Las consultas viven en index.js;
// acá están los fragmentos de SQL parametrizables y el cálculo del devengado.
import { z } from "zod";

// Último día del mes en curso, en formato YYYY-MM-DD. Se calcula en cada
// llamada a propósito: como constante de módulo quedaría congelada al arranque.
const endOfCurrentMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
};

// due_date del mes = período + (min(día de vencimiento, días reales del mes) - 1).
// El LEAST es lo que evita que un vencimiento 31 desaparezca en abril o febrero.
const dueDateSql = (periodExpr, dayExpr) => `(
  ${periodExpr}
  + (LEAST(
       ${dayExpr},
       EXTRACT(DAY FROM (${periodExpr} + INTERVAL '1 month' - INTERVAL '1 day'))::int
     ) - 1) * INTERVAL '1 day'
)::date`;

// "2026-09" -> "2026-09-01". El mes es la unidad, el día siempre es el 1.

const periodSchema = z.string().regex(/^\d{4}-\d{2}$/);
const periodToDate = (period) => `${period}-01`;

const previousPeriodDate = (periodDate) => {
  const d = new Date(`${periodDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};

function eachDate(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function toDateKey(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// Devengado del rango + desgloses. `accrued_total` es exactamente la suma de
// `by_day`, así que el KPI y el gráfico diario ya no pueden discrepar.
function buildAccrual(charges, from, to) {
  const days = eachDate(from, to);
  const perDay = new Map(days.map((day) => [day, 0]));
  const byCategory = new Map();
  const byExpense = new Map();
  let accruedTotal = 0;
  let unpaidTotal = 0;
  let unpaidCount = 0;

  for (const charge of charges) {
    const amount = Number(charge.amount) || 0;
    const daysInMonth = Number(charge.days_in_month) || 1;
    const periodKey = toDateKey(charge.period);
    const chargeDays = days.filter((day) => day.slice(0, 7) === periodKey.slice(0, 7));
    if (chargeDays.length === 0) continue;

    // Se reparten centavos enteros con resto mayor en vez de redondear cada día
    // por separado: así la suma de by_day da EXACTAMENTE accrued_total y el
    // gráfico diario nunca discrepa del KPI, que es el punto de todo esto.
    const totalCents = Math.round((amount * chargeDays.length * 100) / daysInMonth);
    const baseCents = Math.floor(totalCents / chargeDays.length);
    let remainder = totalCents - baseCents * chargeDays.length;
    for (const day of chargeDays) {
      const cents = baseCents + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      perDay.set(day, perDay.get(day) + cents / 100);
    }

    const accrued = totalCents / 100;
    accruedTotal += accrued;

    const catKey = charge.category_id || "sin-categoria";
    const cat = byCategory.get(catKey) || {
      category_id: charge.category_id || null,
      name: charge.category_name || "Sin categoría",
      accrued: 0
    };
    cat.accrued += accrued;
    byCategory.set(catKey, cat);

    const exp = byExpense.get(charge.fixed_expense_id) || {
      fixed_expense_id: charge.fixed_expense_id,
      name: charge.name,
      accrued: 0,
      monthly_amount: amount
    };
    exp.accrued += accrued;
    exp.monthly_amount = amount;
    byExpense.set(charge.fixed_expense_id, exp);

    if (!charge.paid_at) {
      unpaidTotal += amount;
      unpaidCount += 1;
    }
  }

  // Run-rate: lo que cuesta un mes completo al final del rango. Es el número
  // que muestra la página de Gastos Fijos, y NO el devengado del período.
  const lastPeriod = charges.reduce((latest, charge) => {
    const key = toDateKey(charge.period);
    return key > latest ? key : latest;
  }, "");
  const monthlyTotal = charges
    .filter((charge) => toDateKey(charge.period) === lastPeriod)
    .reduce((sum, charge) => sum + (Number(charge.amount) || 0), 0);

  return {
    from,
    to,
    accrued_total: Number(accruedTotal.toFixed(2)),
    monthly_total: Number(monthlyTotal.toFixed(2)),
    by_category: Array.from(byCategory.values())
      .map((cat) => ({ ...cat, accrued: Number(cat.accrued.toFixed(2)) }))
      .sort((a, b) => b.accrued - a.accrued),
    by_expense: Array.from(byExpense.values())
      .map((exp) => ({ ...exp, accrued: Number(exp.accrued.toFixed(2)) }))
      .sort((a, b) => b.accrued - a.accrued),
    by_day: days.map((day) => ({
      date: day,
      amount: Number(((perDay.get(day) || 0) * 100).toFixed(0)) / 100
    })),
    unpaid: { count: unpaidCount, total: Number(unpaidTotal.toFixed(2)) },
    charges: charges.map((charge) => ({
      id: charge.id,
      fixed_expense_id: charge.fixed_expense_id,
      name: charge.name,
      period: toDateKey(charge.period),
      due_date: toDateKey(charge.due_date),
      amount: Number(charge.amount),
      paid_at: charge.paid_at ? toDateKey(charge.paid_at) : null,
      paid_amount: charge.paid_amount === null ? null : Number(charge.paid_amount)
    }))
  };
}

export {
  endOfCurrentMonth,
  dueDateSql,
  periodSchema,
  periodToDate,
  previousPeriodDate,
  eachDate,
  toDateKey,
  buildAccrual
};
