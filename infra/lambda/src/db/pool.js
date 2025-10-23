"use strict";

const { Pool } = require("pg");
const AWS = require("aws-sdk");
const { loadDbConfig } = require("../config/db");
const { schemaGuard } = require("../bootstrap/schemaGuard");

let poolInstance = null;
let guardPromise = null;
let secretPromise = null;

const DEFAULT_QUERY_TIMEOUT_MS = 15000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15000;
const DB_OPERATION_TIMEOUT_MS = Number.parseInt(
  process.env.SAFEPOCKET_DB_OPERATION_TIMEOUT_MS || "9000",
  10,
);

function getDbSecretName() {
  return (
    (process.env.SAFEPOCKET_DB_SECRET_NAME && process.env.SAFEPOCKET_DB_SECRET_NAME.trim()) ||
    (process.env.SECRET_DATABASE_NAME && process.env.SECRET_DATABASE_NAME.trim()) ||
    (process.env.SECRET_DB_NAME && process.env.SECRET_DB_NAME.trim()) ||
    (process.env.DB_SECRET_NAME && process.env.DB_SECRET_NAME.trim()) ||
    (process.env.SECRET_DB && process.env.SECRET_DB.trim()) ||
    (process.env.SECRET_DATABASE && process.env.SECRET_DATABASE.trim()) ||
    "/safepocket/db"
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
    const startedAt = Date.now();
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
      const elapsedMs = Date.now() - startedAt;
      console.info("[lambda] DB secret loaded", { secretName, elapsedMs });
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
  instance.__safepocket = {
    queryTimeout: config.query_timeout || DEFAULT_QUERY_TIMEOUT_MS,
    statementTimeout: config.statement_timeout || DEFAULT_STATEMENT_TIMEOUT_MS,
  };
  instance.on("error", (error) => {
    console.error("[lambda] unexpected PostgreSQL error", error);
  });
  instance.on("connect", () => {
    console.info("[lambda] PostgreSQL client connected");
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

async function setLocalConfig(client, key, value) {
  if (value == null) {
    throw new Error(`setLocalConfig requires a value for ${key}`);
  }
  const settingName = String(key);
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(settingName)) {
    throw new Error(`Invalid SET LOCAL key: ${settingName}`);
  }
  const literal = String(value).replace(/'/g, "''");
  await client.query(`SET LOCAL ${settingName} = '${literal}'`);
}

async function withUserClient(userId, callback) {
  if (!userId) {
    throw new Error("userId is required to establish RLS context");
  }
  const pool = await ensurePgPool();
  const acquireStarted = Date.now();
  const client = await pool.connect();
  const acquireDuration = Date.now() - acquireStarted;
  if (acquireDuration > 1000) {
    console.info("[lambda] PG client acquisition slow", { durationMs: acquireDuration });
  }
  let timeoutId;
  let transactionActive = false;
  const timeoutMs = Number.isFinite(DB_OPERATION_TIMEOUT_MS) ? DB_OPERATION_TIMEOUT_MS : 9000;
  try {
    await client.query("BEGIN");
    transactionActive = true;
    const meta = pool.__safepocket ?? {};
    await setLocalConfig(client, "appsec.user_id", userId);
    if (meta.statementTimeout) {
      const statementTimeout = Number.parseInt(meta.statementTimeout, 10);
      if (Number.isFinite(statementTimeout) && statementTimeout > 0) {
        await setLocalConfig(client, "statement_timeout", statementTimeout);
      }
    }
    const operation = Promise.resolve(callback(client, meta));
    const watchdog = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          Object.assign(new Error(`Database operation timed out after ${timeoutMs} ms`), {
            code: "DB_OPERATION_TIMEOUT",
          }),
        );
      }, timeoutMs);
    });
    const result = await Promise.race([operation, watchdog]);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    await client.query("COMMIT");
    transactionActive = false;
    return result;
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (transactionActive) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.warn("[lambda] failed to rollback transaction", rollbackError);
      } finally {
        transactionActive = false;
      }
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    client.release();
  }
}

module.exports = {
  ensurePgPool,
  getPool,
  closePool,
  loadDbConfig,
  withUserClient,
  pool: {
    get instance() {
      return poolInstance;
    },
  },
};
