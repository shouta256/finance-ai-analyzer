"use strict";

const fs = require("fs");
const path = require("path");

function toInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") continue;
      return trimmed;
    }
    return value;
  }
  return undefined;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseDatabaseUrl(urlString) {
  const url = new URL(urlString);
  const sslMode = url.searchParams.get("sslmode");
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : undefined,
    user: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    database: url.pathname ? url.pathname.replace(/^\//, "") : undefined,
    sslMode: sslMode ? sslMode.toLowerCase() : undefined,
  };
}

function readCertificate(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch (error) {
      console.warn(`[lambda] unable to read certificate ${candidate}: ${error.message}`);
    }
  }
  return null;
}

function resolveSsl(parsedUrl, host) {
  const sslFlag = parseBool(process.env.SAFEPOCKET_DB_SSL, undefined);
  const explicitMode = (process.env.SAFEPOCKET_DB_SSL_MODE ||
    process.env.PGSSLMODE ||
    (parsedUrl ? parsedUrl.sslMode : null) ||
    "").trim().toLowerCase();

  const normalizedHost = (host || (parsedUrl ? parsedUrl.host : "") || "").toLowerCase();
  const isLocalHost = ["localhost", "127.0.0.1", "::1", "postgres"].includes(normalizedHost);
  const shouldUseSsl =
    sslFlag !== undefined
      ? sslFlag
      : explicitMode
        ? !["disable", "allow", "prefer", "off"].includes(explicitMode)
        : !isLocalHost;

  if (!shouldUseSsl) return false;

  const rejectUnauthorized = parseBool(process.env.SAFEPOCKET_DB_SSL_REJECT_UNAUTHORIZED, true);
  const inlineCa =
    process.env.SAFEPOCKET_DB_CA_CERT ||
    process.env.PGSSLROOTCERT ||
    process.env.SAFEPOCKET_DB_SSL_CA;
  const useRdsCa = normalizedHost.includes(".rds.amazonaws.com");

  const ca = inlineCa && inlineCa.trim()
    ? inlineCa.includes("-----BEGIN")
      ? inlineCa.replace(/\\n/g, "\n")
      : Buffer.from(inlineCa, "base64").toString("utf8")
    : readCertificate([
        process.env.SAFEPOCKET_DB_CA_PATH,
        useRdsCa ? path.join(__dirname, "../../certs/rds-combined-ca-bundle.pem") : null,
      ]);

  const ssl = { rejectUnauthorized };
  if (ca && ca.trim()) {
    ssl.ca = ca;
  }

  const clientCert = process.env.SAFEPOCKET_DB_CLIENT_CERT;
  const clientKey = process.env.SAFEPOCKET_DB_CLIENT_KEY;
  if (clientCert && clientCert.trim()) {
    ssl.cert = clientCert.replace(/\\n/g, "\n");
  }
  if (clientKey && clientKey.trim()) {
    ssl.key = clientKey.replace(/\\n/g, "\n");
  }

  return ssl;
}

function loadDbConfig() {
  const databaseUrl = process.env.SAFEPOCKET_DATABASE_URL || process.env.DATABASE_URL || null;
  let parsed = {};
  if (databaseUrl) {
    try {
      parsed = parseDatabaseUrl(databaseUrl);
    } catch (error) {
      throw new Error(`Invalid database URL: ${error.message}`);
    }
  }

  const host = firstNonEmpty(
    process.env.SAFEPOCKET_DB_HOST,
    parsed.host,
    process.env.PGHOST,
    process.env.DB_HOST,
    process.env.RDS_HOSTNAME,
  );
  const port = toInt(
    firstNonEmpty(process.env.SAFEPOCKET_DB_PORT, parsed.port, process.env.PGPORT, process.env.DB_PORT, process.env.RDS_PORT),
    5432,
  );
  const user = firstNonEmpty(
    process.env.SAFEPOCKET_DB_USER,
    parsed.user,
    process.env.PGUSER,
    process.env.DB_USER,
    process.env.RDS_USERNAME,
  );
  const rawPassword = firstNonEmpty(
    process.env.SAFEPOCKET_DB_PASSWORD,
    parsed.password,
    process.env.PGPASSWORD,
    process.env.DB_PASSWORD,
    process.env.RDS_PASSWORD,
  );
  const database = firstNonEmpty(
    process.env.SAFEPOCKET_DB_NAME,
    parsed.database,
    process.env.PGDATABASE,
    process.env.DB_NAME,
    process.env.RDS_DB_NAME,
  );

  if (!host) {
    throw new Error(
      "Database host is not configured. Set SAFEPOCKET_DB_HOST, PGHOST, RDS_HOSTNAME, or SAFEPOCKET_DATABASE_URL.",
    );
  }
  if (!user) {
    throw new Error("Database user is not configured. Set SAFEPOCKET_DB_USER, PGUSER, or SAFEPOCKET_DATABASE_URL.");
  }
  if (!database) {
    throw new Error("Database name is not configured. Set SAFEPOCKET_DB_NAME, PGDATABASE, or SAFEPOCKET_DATABASE_URL.");
  }

  const config = {
    host,
    port,
    user,
    password: rawPassword,
    database,
    max: toInt(process.env.SAFEPOCKET_DB_POOL_MAX, 6),
    idleTimeoutMillis: toInt(process.env.SAFEPOCKET_DB_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: toInt(process.env.SAFEPOCKET_DB_CONNECTION_TIMEOUT_MS, 5000),
    application_name: process.env.SAFEPOCKET_DB_APP_NAME || "safepocket-lambda",
    statement_timeout: toInt(process.env.SAFEPOCKET_DB_STATEMENT_TIMEOUT_MS, 15000),
    query_timeout: toInt(process.env.SAFEPOCKET_DB_QUERY_TIMEOUT_MS, 15000),
    keepAlive: parseBool(process.env.SAFEPOCKET_DB_KEEP_ALIVE, true),
    allowExitOnIdle: parseBool(process.env.SAFEPOCKET_DB_ALLOW_EXIT_ON_IDLE, true),
  };

  if (databaseUrl) {
    config.connectionString = databaseUrl;
  }

  const ssl = resolveSsl(parsed, host);
  if (ssl === false) {
    config.ssl = false;
  } else if (ssl) {
    config.ssl = ssl;
  }

  return config;
}

module.exports = {
  loadDbConfig,
  parseDatabaseUrl,
};
