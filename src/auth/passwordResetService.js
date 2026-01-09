import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { z } from "zod";

export const forgotPasswordSchema = z.object({
  email: z.string().email()
});

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(8)
});

export class PasswordResetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const generateResetToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

export const hashResetToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

export const buildResetLink = (baseUrl, token) => {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
};

export const createPasswordResetService = ({
  store,
  sendResetEmail,
  now = () => new Date(),
  tokenTtlMs = 60 * 60 * 1000,
  hashPassword = (password) => bcrypt.hash(password, 10),
  resetUrlBase = "https://miapp.com/reset-password"
}) => {
  const safeAudit = async (entry) => {
    try {
      await store.insertAuditLog(entry);
    } catch (err) {
      console.error("Failed to write audit log", err);
    }
  };

  const validatePassword = (password) => {
    const parsed = z.string().min(8).safeParse(password);
    if (!parsed.success) {
      throw new PasswordResetError("weak_password", "Password does not meet requirements");
    }
  };

  const requestReset = async (email, { ip, userAgent }) => {
    const user = await store.getUserByEmail(email);
    if (!user) {
      await safeAudit({
        eventType: "password_reset_requested",
        email,
        ip,
        userAgent,
        success: false,
        detail: "email_not_found"
      });
      return { ok: true };
    }

    const token = generateResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(now().getTime() + tokenTtlMs);

    await store.createResetToken({ userId: user.id, tokenHash, expiresAt });
    const resetLink = buildResetLink(resetUrlBase, token);

    try {
      await sendResetEmail({ to: user.email, resetLink });
    } catch (err) {
      console.error("Failed to send reset email", err);
    }

    await safeAudit({
      eventType: "password_reset_requested",
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
      success: true
    });

    return { ok: true };
  };

  const resetPassword = async (token, newPassword, { ip, userAgent }) => {
    try {
      validatePassword(newPassword);
    } catch (err) {
      await safeAudit({
        eventType: "password_reset_failed",
        ip,
        userAgent,
        success: false,
        detail: "weak_password"
      });
      throw err;
    }

    const tokenHash = hashResetToken(token);
    const passwordHash = await hashPassword(newPassword);
    const result = await store.consumeResetToken({
      tokenHash,
      passwordHash,
      now: now()
    });

    if (!result.ok) {
      await safeAudit({
        eventType: "password_reset_failed",
        userId: result.userId ?? null,
        ip,
        userAgent,
        success: false,
        detail: result.reason ?? "invalid_or_expired"
      });
      throw new PasswordResetError("invalid_or_expired", "Invalid or expired token");
    }

    await safeAudit({
      eventType: "password_reset_completed",
      userId: result.userId,
      ip,
      userAgent,
      success: true
    });

    return { ok: true };
  };

  return { requestReset, resetPassword };
};
