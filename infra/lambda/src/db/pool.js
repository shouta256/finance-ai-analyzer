"use strict";

const { Pool } = require("pg");
const AWS = require("aws-sdk");
const { loadDbConfig } = require("../config/db");
const { schemaGuard, SchemaNotMigratedError } = require("../bootstrap/schemaGuard");

let poolInstance = null;
let guardPromise = null;
let secretPromise = null;

function getDbSecretName() {
  return (
    process.env.SAFEPOCKET_DB_SECRET_NAME ||
    process.env.SECRET_DATABASE_NAME ||
    process.env.SECRET_DB_NAME ||
    process.env.DB_SECRET_NAME ||
    process.env.SECRET_DB ||
    process.env.SECRET_DATABASE ||
    null
  );
}

async function hydrateDbConfigFromSecret() {
  if (secretPromise) {
    return secretPromise;
  }
  const secretName = getDbSecretName();
  if (!secretName) {
    secretPromise = Promise.resolve();
    return secretPromise;
  }
  const secretsManager = new AWS.SecretsManager();
  secretPromise = (async () => {
    try {
      const res = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
      const payload = res.SecretString ?? Buffer.from(res.SecretBinary, "base64").toString("utf8");
      if (!payload) {
        throw new Error("Secret payload empty");
      }
      const secret = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (typeof secret !== "object" || secret === null) {
        throw new Error("Secret payload is not an object");
      }
      const mappings = [
        ["SAFEPOCKET_DATABASE_URL", ["url", "jdbcUrl", "jdbc_url", "connectionString", "connection_string"]],
        ["DATABASE_URL", ["url", "jdbcUrl", "jdbc_url", "connectionString", "connection_string"]],
        ["SAFEPOCKET_DB_HOST", ["host", "hostname", "dbHost", "readerEndpoint", "writerEndpoint"]],
        ["PGHOST", ["host", "hostname", "dbHost", "readerEndpoint", "writerEndpoint"]],
        ["SAFEPOCKET_DB_PORT", ["port", "dbPort"]],
        ["PGPORT", ["port", "dbPort"]],
        ["SAFEPOCKET_DB_USER", ["username", "user", "dbUser"]],
        ["PGUSER", ["username", "user", "dbUser"]],
        ["SAFEPOCKET_DB_PASSWORD", ["password", "dbPassword"]],
        ["PGPASSWORD", ["password", "dbPassword"]],
        ["SAFEPOCKET_DB_NAME", ["dbname", "dbName", "database"]],
        ["PGDATABASE", ["dbname", "dbName", "database"]],
        ["SAFEPOCKET_DB_SSL", ["ssl", "requireSsl"]],
        ["SAFEPOCKET_DB_SSL_MODE", ["sslmode", "sslMode"]],
        ["SAFEPOCKET_DB_SCHEMA", ["schema", "searchPath"]],
      ];
      for (const [envKey, keys] of mappings) {
        if (process.env[envKey]) continue;
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(secret, key) && secret[key] !== undefined && secret[key] !== null) {
            const value = typeof secret[key] === "string" ? secret[key].trim() : secret[key];
            if (value === "" || value === null) continue;
            process.env[envKey] = String(value);
            break;
          }
        }
      }
    } catch (error) {
      console.warn(`[lambda] unable to hydrate DB config from secret ${secretName}: ${error.message}`);
    }
  })();
  return secretPromise;
}

function createPool() {
  const config = loadDbConfig();
  console.info("[lambda] PostgreSQL pool initialised", {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user ? `${config.user.slice(0, 2)}***` : undefined,
    ssl: config.ssl ? { ca: Boolean(config.ssl.ca), cert: Boolean(config.ssl.cert), rejectUnauthorized: config.ssl.rejectUnauthorized } : false,
    max: config.max,
  });
  const instance = new Pool(config);
  instance.on("error", (error) => {
    console.error("[lambda] unexpected PostgreSQL error", error);
  });
  return instance;
}

async function ensurePgPool() {
  await hydrateDbConfigFromSecret();

  if (!poolInstance) {
    poolInstance = createPool();
  }

  if (!guardPromise) {
    guardPromise = schemaGuard(poolInstance)
      .catch(async (error) => {
        await closePool().catch(() => undefined);
        throw error;
      })
      .finally(() => {
        guardPromise = null;
      });
  }

  await guardPromise;
  return poolInstance;
}

function getPool() {
  if (!poolInstance) {
    throw new Error("PostgreSQL pool not initialised. Call ensurePgPool() first.");
  }
  return poolInstance;
}

async function closePool() {
  if (!poolInstance) return;
  const current = poolInstance;
  poolInstance = null;
  guardPromise = null;
  try {
    await current.end();
  } catch (error) {
    console.warn("[lambda] failed to close PostgreSQL pool cleanly", error);
  }
}

module.exports = {
  ensurePgPool,
  getPool,
  closePool,
  loadDbConfig,
  pool: {
    get instance() {
      return poolInstance;
    },
  },
};
