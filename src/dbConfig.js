import fs from "node:fs";

function getSslMode(connectionString) {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    return url.searchParams.get("sslmode");
  } catch {
    return null;
  }
}

function parseBool(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function buildPoolConfig(connectionString) {
  const sslmode = getSslMode(connectionString);
  const sslRequested =
    sslmode ? sslmode !== "disable" : parseBool(process.env.DATABASE_SSL) === true;

  const config = { connectionString };
  if (!sslRequested) return config;

  const rejectUnauthorizedEnv = parseBool(
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
  );
  const rejectUnauthorized =
    rejectUnauthorizedEnv ??
    (sslmode === "verify-ca" || sslmode === "verify-full");

  const ssl = { rejectUnauthorized };
  const caPath = process.env.DATABASE_SSL_CA;
  if (caPath) {
    ssl.ca = fs.readFileSync(caPath, "utf8");
  } else {
    const defaultCaPath = `${process.cwd()}/archivoCA.crt`;
    if (fs.existsSync(defaultCaPath)) {
      // Allow local dev to trust bundled CA when env var is not set.
      ssl.ca = fs.readFileSync(defaultCaPath, "utf8");
    }
  }
  config.ssl = ssl;
  return config;
}
