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
  const res = await client.query(
    `SELECT id, user_id, status, item_id, cursor, created_at, updated_at
     FROM user_plaid_items
     WHERE user_id = current_setting('appsec.user_id', true)::uuid
     ORDER BY created_at DESC`,
  );
  return { plaidItems: res.rows };
}

/**
 * Ensure Plaid items constraints exist (admin only)
 */
async function ensurePlaidItemsConstraints(client) {
  await client.query(
    `ALTER TABLE user_plaid_items DROP CONSTRAINT IF EXISTS user_plaid_items_user_item_unique`,
  );
  await client.query(
    `ALTER TABLE user_plaid_items ADD CONSTRAINT user_plaid_items_user_item_unique
     UNIQUE (user_id, item_id)`,
  );
  return { status: "CONSTRAINTS_ENSURED" };
}

/**
 * Handle DNS diagnostics
 */
async function handleDnsDiagnostics(event) {
  const target = event.queryStringParameters?.host || "sandbox.plaid.com";
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const addresses = await dns.lookup(target, { all: true });
    return respond(event, 200, {
      target,
      addresses,
      traceId,
    });
  } catch (error) {
    return respond(event, 500, {
      error: {
        code: "DNS_LOOKUP_FAILED",
        message: error?.message || "DNS lookup failed",
        target,
        traceId,
      },
    });
  }
}

/**
 * Handle DB maintenance diagnostics (admin only)
 */
async function handleDiagnosticsDbMaintenance(event) {
  const adminHdr = event.headers?.["x-admin"] || event.headers?.["X-Admin"];
  if (!ADMIN_SQL_TOKEN || adminHdr !== ADMIN_SQL_TOKEN) {
    return respond(event, 403, { error: "forbidden" });
  }
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const result = await withUserClient(ANON_USER_ID, (client) =>
      ensurePlaidItemsConstraints(client),
    );
    return respond(event, 200, { ...result, traceId });
  } catch (error) {
    return respond(event, 500, {
      error: {
        code: "DB_MAINT_FAILED",
        message: error?.message || "DB maintenance failed",
        traceId,
      },
    });
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
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const res = await withUserClient(ANON_USER_ID, (c) =>
      ensurePlaidItemsConstraints(c),
    );
    return respond(event, 200, { ...res, traceId });
  } catch (error) {
    return respond(event, 500, {
      error: {
        code: "ENSURE_CONSTRAINTS_FAILED",
        message: error?.message || "Failed to ensure constraints",
        traceId,
      },
    });
  }
}

module.exports = {
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
  checkPlaidItems,
  ensurePlaidItemsConstraints,
};
