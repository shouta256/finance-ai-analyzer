"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const { authenticate } = require("../services/auth");
const { respond } = require("../utils/response");
const { withUserClient } = require("../db/pool");
const { ANON_USER_ID, ADMIN_SQL_TOKEN } = require("../utils/constants");

/**
 * Check Plaid items for a user
 */
async function checkPlaidItems(client) {
  const constraints = await client.query(
    "SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'plaid_items' AND c.contype = 'u' ORDER BY conname",
  );
  const dupItem = await client.query(
    "SELECT item_id, COUNT(*) AS cnt FROM plaid_items GROUP BY item_id HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 50",
  );
  const dupUserItem = await client.query(
    "SELECT user_id, item_id, COUNT(*) AS cnt FROM plaid_items GROUP BY user_id, item_id HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 50",
  );
  return {
    constraints: constraints.rows,
    dupByItem: dupItem.rows,
    dupByUserItem: dupUserItem.rows,
  };
}

/**
 * Ensure Plaid items constraints exist (admin only)
 */
async function ensurePlaidItemsConstraints(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plaid_items_item_unique'
      ) THEN
        ALTER TABLE plaid_items
          ADD CONSTRAINT plaid_items_item_unique UNIQUE (item_id);
      END IF;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plaid_items_user_item_unique'
      ) THEN
        ALTER TABLE plaid_items
          ADD CONSTRAINT plaid_items_user_item_unique UNIQUE (user_id, item_id);
      END IF;
    END $$;
  `);
  await client.query("CREATE INDEX IF NOT EXISTS plaid_items_user_idx ON plaid_items(user_id)");
  return { ok: true };
}

/**
 * Handle DNS diagnostics
 */
async function handleDnsDiagnostics(event) {
  const result = {};
  const recordHosts = [
    ["exampleA", "example.com"],
    ["apexA", "plaid.com"],
    ["apiA", "api.plaid.com"],
  ];
  for (const [label, host] of recordHosts) {
    try {
      result[label] = await dns.resolve4(host);
    } catch (error) {
      result[`${label}_err`] = error?.code || String(error);
    }
  }
  return respond(event, 200, result);
}

/**
 * Handle DB maintenance diagnostics (admin only)
 */
async function handleDiagnosticsDbMaintenance(event) {
  const headers = event.headers || {};
  const adminToken = process.env.DB_ADMIN_TOKEN || ADMIN_SQL_TOKEN;
  const supplied =
    headers["x-admin-token"] ||
    headers["X-Admin-Token"] ||
    headers["x-admin"] ||
    headers["X-Admin"] ||
    "";
  if (!adminToken || supplied !== adminToken) {
    return respond(event, 403, { error: "forbidden" });
  }
  try {
    const result = await withUserClient(ANON_USER_ID, (client) =>
      ensurePlaidItemsConstraints(client),
    );
    return respond(event, 200, { status: "ok", details: result });
  } catch (error) {
    console.error("[maint] failed to apply constraints", { code: error?.code, message: error?.message });
    return respond(event, 500, { error: error?.message || "constraint_update_failed", code: error?.code });
  }
}

/**
 * Handle Plaid items diagnostics
 */
async function handleDiagnosticsPlaidItems(event) {
  const payload = await authenticate(event);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const res = await withUserClient(payload.sub, (c) => checkPlaidItems(c));
    return respond(event, 200, { ...res, traceId });
  } catch (error) {
    return respond(event, 500, {
      error: {
        code: "PLAID_ITEMS_CHECK_FAILED",
        message: error?.message || "Failed to check plaid items",
        traceId,
      },
    });
  }
}

/**
 * Handle admin ensure constraints
 */
async function handleAdminEnsureConstraints(event) {
  const adminHdr = event.headers?.["x-admin"] || event.headers?.["X-Admin"];
  if (!ADMIN_SQL_TOKEN || adminHdr !== ADMIN_SQL_TOKEN) {
    return respond(event, 403, { error: "forbidden" });
  }
  const res = await withUserClient(ANON_USER_ID, (c) => ensurePlaidItemsConstraints(c));
  return respond(event, 200, res);
}

module.exports = {
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
  checkPlaidItems,
  ensurePlaidItemsConstraints,
};
