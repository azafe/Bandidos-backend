// Cubre el proxy del asistente de IA: la API key de Anthropic vive solo acá
// (nunca en el bundle del frontend) y el límite de consultas es real —lo
// aplica el servidor, no un contador de localStorage que cualquiera podía
// resetear.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://localhost:5432/postgres";
process.env.JWT_SECRET ||= "test-secret";

const { app } = await import("../src/index.js");
const { pool } = await import("../src/db.js");
const jwt = (await import("jsonwebtoken")).default;

const tokenFor = (tenantId) =>
  jwt.sign(
    { sub: crypto.randomUUID(), role: "admin", email: "admin@test.com", tenant_id: tenantId },
    process.env.JWT_SECRET
  );

async function withServer(fn) {
  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql) => {
    if (sql.toLowerCase().includes("select status, suspended_reason from tenants")) {
      return { rowCount: 1, rows: [{ status: "active", suspended_reason: null }] };
    }
    throw new Error(`Unexpected SQL in assistant-proxy test: ${sql}`);
  };

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const postAssistant = (baseUrl, token, body) =>
  fetch(`${baseUrl}/v2/assistant/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });

const validBody = {
  system: "Sos el asistente de Bandidos.",
  messages: [{ role: "user", content: "¿Cuánto facturamos hoy?" }]
};

test("proxy del asistente de IA", async (t) => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env.ANTHROPIC_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  // El mock de fetch tiene que distinguir el pedido HTTP local que hace el
  // propio test (postAssistant -> 127.0.0.1) del pedido que hace el backend
  // hacia Anthropic: ambos pasan por el mismo `fetch` global.
  const mockAnthropicFetch = (handleAnthropicCall) => {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("api.anthropic.com")) {
        return handleAnthropicCall(url, options);
      }
      return originalFetch(url, options);
    };
  };

  await t.test("sin ANTHROPIC_API_KEY configurada, devuelve 500 y no llama a Anthropic", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    mockAnthropicFetch(() => {
      called = true;
      throw new Error("no debería llamarse a Anthropic sin API key");
    });

    await withServer(async (baseUrl) => {
      const res = await postAssistant(baseUrl, tokenFor(crypto.randomUUID()), validBody);
      assert.equal(res.status, 500);
      assert.equal(called, false);
    });
  });

  await t.test("con la key configurada, llama a Anthropic del lado del servidor y descuenta cupo", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    let capturedHeaders = null;
    mockAnthropicFetch((url, options) => {
      capturedHeaders = options.headers;
      return new Response(
        JSON.stringify({ content: [{ text: "Facturaste $50.000 hoy." }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await withServer(async (baseUrl) => {
      const res = await postAssistant(baseUrl, tokenFor(crypto.randomUUID()), validBody);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.reply, "Facturaste $50.000 hoy.");
      assert.equal(body.queriesLeft, 19);
      assert.equal(capturedHeaders["x-api-key"], "sk-ant-test-key");
    });
  });

  await t.test("un body inválido (sin messages) da 400", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    mockAnthropicFetch(() => {
      throw new Error("no debería llamarse a Anthropic con body inválido");
    });
    await withServer(async (baseUrl) => {
      const res = await postAssistant(baseUrl, tokenFor(crypto.randomUUID()), { system: "x" });
      assert.equal(res.status, 400);
    });
  });

  await t.test("al agotar las 20 consultas del mes, devuelve 429 sin llamar a Anthropic", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    let callCount = 0;
    mockAnthropicFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ content: [{ text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const tenantId = crypto.randomUUID();
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 20; i += 1) {
        const res = await postAssistant(baseUrl, tokenFor(tenantId), validBody);
        assert.equal(res.status, 200);
      }
      const blocked = await postAssistant(baseUrl, tokenFor(tenantId), validBody);
      assert.equal(blocked.status, 429);
      assert.equal(callCount, 20);
    });
  });
});
