"use strict";

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

class SchemaNotMigratedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaNotMigratedError";
    this.statusCode = 503;
  }
}

async function runChecks(pool) {
  const client = await pool.connect();
  try {
    const migration = await client.query(
      "SELECT success, version, description FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1",
    );
    if (migration.rowCount === 0) {
      throw new SchemaNotMigratedError("Database migrations have not been applied (flyway_schema_history empty).");
    }
    const latest = migration.rows[0];
    if (!latest.success) {
      throw new SchemaNotMigratedError(
        `Database migrations incomplete. Latest migration ${latest.version || "unknown"} failed.`,
      );
    }

    const schemaName = process.env.SAFEPOCKET_DB_SCHEMA || "public";
    const tableList =
      process.env.SAFEPOCKET_DB_REQUIRED_TABLES || "transactions,accounts,merchants,users,plaid_items";
    const requiredTables = tableList
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (requiredTables.length > 0) {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)",
        [schemaName, requiredTables],
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      const missing = requiredTables.filter((table) => !present.has(table));
      if (missing.length > 0) {
        throw new SchemaNotMigratedError(`Database schema missing required tables: ${missing.join(", ")}`);
      }
    }
  } catch (error) {
    if (error instanceof SchemaNotMigratedError) {
      throw error;
    }
    if (error && error.code === "42P01") {
      throw new SchemaNotMigratedError("Database migrations have not been applied (flyway_schema_history missing).");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function schemaGuard(pool) {
  const enabled = parseBool(process.env.SAFEPOCKET_DB_SCHEMA_GUARD_ENABLED, true);
  if (!enabled) return;
  await runChecks(pool);
}

module.exports = {
  schemaGuard,
  SchemaNotMigratedError,
};
