export const createPasswordResetStore = (pool) => {
  const getUserByEmail = async (email) => {
    const result = await pool.query("SELECT id, email FROM users WHERE email = $1", [email]);
    return result.rows[0] ?? null;
  };

  const createResetToken = async ({ userId, tokenHash, expiresAt }) => {
    const result = await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, expires_at, used_at, created_at`,
      [userId, tokenHash, expiresAt]
    );
    return result.rows[0];
  };

  const consumeResetToken = async ({ tokenHash, passwordHash, now }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tokenResult = await client.query(
        `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens
         WHERE token_hash = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [tokenHash]
      );

      if (tokenResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "invalid_or_expired" };
      }

      const token = tokenResult.rows[0];
      if (token.used_at || token.expires_at <= now) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "invalid_or_expired", userId: token.user_id };
      }

      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
        passwordHash,
        token.user_id
      ]);
      await client.query("UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2", [
        now,
        token.id
      ]);
      await client.query("COMMIT");
      return { ok: true, userId: token.user_id };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const insertAuditLog = async ({
    eventType,
    userId,
    email,
    ip,
    userAgent,
    success = true,
    detail
  }) => {
    await pool.query(
      `INSERT INTO auth_audit_logs (event_type, user_id, email, ip, user_agent, success, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventType, userId ?? null, email ?? null, ip ?? null, userAgent ?? null, success, detail ?? null]
    );
  };

  return {
    getUserByEmail,
    createResetToken,
    consumeResetToken,
    insertAuditLog
  };
};
