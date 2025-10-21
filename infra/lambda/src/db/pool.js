"use strict";

const { Pool } = require("pg");
const { loadDbConfig } = require("../config/db");
const { schemaGuard, SchemaNotMigratedError } = require("../bootstrap/schemaGuard");

let poolInstance = null;
let guardPromise = null;

function createPool() {
  const config = loadDbConfig();
  const instance = new Pool(config);
  instance.on("error", (error) => {
    console.error("[lambda] unexpected PostgreSQL error", error);
  });
  return instance;
}

async function ensurePgPool() {
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

  try {
    await guardPromise;
  } catch (error) {
    if (error instanceof SchemaNotMigratedError) {
      throw error;
    }
    throw error;
  }

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
