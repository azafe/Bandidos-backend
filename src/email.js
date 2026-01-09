import nodemailer from "nodemailer";

const parseBool = (value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

export const createEmailClient = () => {
  const from = process.env.EMAIL_FROM || "no-reply@miapp.com";
  const provider = process.env.EMAIL_PROVIDER || (process.env.SMTP_HOST ? "smtp" : "log");

  if (provider === "log") {
    return {
      sendPasswordResetEmail: async ({ to, resetLink }) => {
        console.info("Password reset email", { to, resetLink });
      }
    };
  }

  if (!process.env.SMTP_HOST) {
    console.warn("SMTP_HOST not configured, falling back to log email mode.");
    return {
      sendPasswordResetEmail: async ({ to, resetLink }) => {
        console.info("Password reset email", { to, resetLink });
      }
    };
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = parseBool(process.env.SMTP_SECURE) ?? port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });

  return {
    sendPasswordResetEmail: async ({ to, resetLink }) => {
      const subject = "Restablecer contraseña";
      const text = `Recibimos una solicitud para restablecer tu contraseña.

Usa este link para continuar: ${resetLink}

Si no solicitaste el cambio, ignora este correo.`;
      const html = `<p>Recibimos una solicitud para restablecer tu contraseña.</p>
<p><a href="${resetLink}">Restablecer contraseña</a></p>
<p>Si no solicitaste el cambio, ignora este correo.</p>`;

      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
      });
    }
  };
};
