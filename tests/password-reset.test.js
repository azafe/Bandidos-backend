import test from "node:test";
import assert from "node:assert/strict";
import {
  createPasswordResetService,
  hashResetToken,
  PasswordResetError
} from "../src/auth/passwordResetService.js";

const createMemoryStore = () => {
  const users = new Map();
  const tokens = new Map();
  const audits = [];
  let tokenSeq = 0;

  return {
    addUser(user) {
      users.set(user.email, { ...user });
    },
    getUserByEmail: async (email) => users.get(email) ?? null,
    createResetToken: async ({ userId, tokenHash, expiresAt }) => {
      const record = {
        id: `token-${tokenSeq++}`,
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
        created_at: new Date()
      };
      tokens.set(record.id, record);
      return record;
    },
    consumeResetToken: async ({ tokenHash, passwordHash, now }) => {
      const record = [...tokens.values()]
        .filter((item) => item.token_hash === tokenHash)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!record) {
        return { ok: false, reason: "invalid_or_expired" };
      }
      if (record.used_at || record.expires_at <= now) {
        return { ok: false, reason: "invalid_or_expired", userId: record.user_id };
      }
      record.used_at = now;
      const user = [...users.values()].find((item) => item.id === record.user_id);
      if (user) {
        user.password_hash = passwordHash;
      }
      return { ok: true, userId: record.user_id };
    },
    insertAuditLog: async (entry) => {
      audits.push(entry);
    },
    getAudits() {
      return audits;
    },
    getTokens() {
      return tokens;
    }
  };
};

test("forgot password hides missing email", async () => {
  const store = createMemoryStore();
  let sent = 0;
  const service = createPasswordResetService({
    store,
    sendResetEmail: async () => {
      sent += 1;
    }
  });

  const result = await service.requestReset("missing@example.com", {
    ip: "127.0.0.1",
    userAgent: "test"
  });

  assert.equal(result.ok, true);
  assert.equal(sent, 0);
  assert.equal(store.getTokens().size, 0);
  assert.equal(store.getAudits().length, 1);
});

test("reset password rejects invalid token", async () => {
  const store = createMemoryStore();
  const service = createPasswordResetService({
    store,
    sendResetEmail: async () => {},
    hashPassword: async (password) => `hash:${password}`
  });

  await assert.rejects(
    service.resetPassword("invalid-token", "NuevaClave123", {
      ip: "127.0.0.1",
      userAgent: "test"
    }),
    (err) => err instanceof PasswordResetError && err.code === "invalid_or_expired"
  );
});

test("reset password rejects expired token", async () => {
  const store = createMemoryStore();
  store.addUser({ id: "user-1", email: "a@b.com", password_hash: "old" });
  const service = createPasswordResetService({
    store,
    sendResetEmail: async () => {},
    hashPassword: async (password) => `hash:${password}`
  });

  const token = "expiredtoken";
  await store.createResetToken({
    userId: "user-1",
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() - 1000)
  });

  await assert.rejects(
    service.resetPassword(token, "NuevaClave123", { ip: "127.0.0.1", userAgent: "test" }),
    (err) => err instanceof PasswordResetError && err.code === "invalid_or_expired"
  );
});

test("reset password rejects reused token", async () => {
  const store = createMemoryStore();
  store.addUser({ id: "user-2", email: "c@d.com", password_hash: "old" });
  const service = createPasswordResetService({
    store,
    sendResetEmail: async () => {},
    hashPassword: async (password) => `hash:${password}`
  });

  const token = "validtoken";
  await store.createResetToken({
    userId: "user-2",
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  });

  await service.resetPassword(token, "NuevaClave123", {
    ip: "127.0.0.1",
    userAgent: "test"
  });

  await assert.rejects(
    service.resetPassword(token, "OtraClave123", { ip: "127.0.0.1", userAgent: "test" }),
    (err) => err instanceof PasswordResetError && err.code === "invalid_or_expired"
  );
});

test("reset password rejects weak password", async () => {
  const store = createMemoryStore();
  const service = createPasswordResetService({
    store,
    sendResetEmail: async () => {},
    hashPassword: async (password) => `hash:${password}`
  });

  await assert.rejects(
    service.resetPassword("tokentest", "123", { ip: "127.0.0.1", userAgent: "test" }),
    (err) => err instanceof PasswordResetError && err.code === "weak_password"
  );
});
