"use strict";

const crypto = require("crypto");
const { authenticate, optionalAuthenticate } = require("../services/auth");
const {
  queryTransactionsWithClient,
  queryAccountsWithClient,
  updateTransactionCategory,
  ensureUserRow,
  syncFromPlaid,
} = require("../services/transactions");
const { respond } = require("../utils/response");
const { parseJsonBody, createHttpError } = require("../utils/helpers");
const { withUserClient } = require("../db/pool");
const { UUID_REGEX, DEV_USER_ID } = require("../utils/constants");
const { generateDemoAccounts, generateDemoTransactions } = require("../services/demo");

/**
 * Check if user is demo user
 */
function isDemoUser(userId) {
  return userId === DEV_USER_ID;
}

/**
 * Handle GET/PATCH /transactions
 */
async function handleTransactions(event) {
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  const payload = await authenticate(event);
  const isDemo = isDemoUser(payload.sub);

  // GET - List transactions
  if (method === "GET") {
    const qs = event.queryStringParameters || {};

    // Parse date range
    let start, end;
    if (qs.start && qs.end) {
      start = new Date(qs.start);
      end = new Date(qs.end);
    } else {
      const rawMonth = qs.month || new Date().toISOString().slice(0, 7);
      const [yyyy, mm] = rawMonth.split("-").map(Number);
      start = new Date(Date.UTC(yyyy, mm - 1, 1));
      end = new Date(Date.UTC(yyyy, mm, 1));
    }

    // Validate dates
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return respond(event, 400, {
        error: { code: "INVALID_DATE_RANGE", message: "Invalid date range parameters", traceId },
      });
    }

    // Demo user - return generated demo data
    if (isDemo) {
      try {
        const demoTransactions = generateDemoTransactions(start, end, payload.sub);
        return respond(event, 200, { 
          transactions: demoTransactions, 
          traceId,
          isDemo: true 
        });
      } catch (error) {
        console.error("[transactions] demo generation failed", { message: error?.message });
        return respond(event, 500, {
          error: { code: "DEMO_GENERATION_FAILED", message: "Failed to generate demo data", traceId },
        });
      }
    }

    // Regular user - fetch from DB
    try {
      const transactions = await withUserClient(payload.sub, async (client) => {
        await ensureUserRow(client, payload);
        return queryTransactionsWithClient(client, start, end);
      });
      return respond(event, 200, { transactions, traceId });
    } catch (error) {
      console.error("[transactions] fetch failed", { message: error?.message });
      return respond(event, 500, {
        error: { code: "FETCH_FAILED", message: "Failed to fetch transactions", traceId },
      });
    }
  }

  // PATCH - Update transaction category
  if (method === "PATCH") {
    // Demo user cannot update
    if (isDemo) {
      return respond(event, 403, {
        error: { code: "DEMO_MODE", message: "Demo users cannot modify transactions", traceId },
      });
    }

    let body;
    try {
      body = parseJsonBody(event);
    } catch {
      return respond(event, 400, {
        error: { code: "INVALID_REQUEST", message: "Invalid JSON body", traceId },
      });
    }

    const { transactionId, category } = body;
    if (!transactionId || !UUID_REGEX.test(transactionId)) {
      return respond(event, 400, {
        error: { code: "INVALID_REQUEST", message: "Invalid transaction ID", traceId },
      });
    }
    if (typeof category !== "string" || !category.trim()) {
      return respond(event, 400, {
        error: { code: "INVALID_REQUEST", message: "Category is required", traceId },
      });
    }

    try {
      const updated = await withUserClient(payload.sub, async (client) => {
        await ensureUserRow(client, payload);
        return updateTransactionCategory(client, transactionId, category.trim());
      });

      if (!updated) {
        return respond(event, 404, {
          error: { code: "NOT_FOUND", message: "Transaction not found or not owned by user", traceId },
        });
      }

      return respond(event, 200, { transaction: updated, traceId });
    } catch (error) {
      console.error("[transactions] update failed", { message: error?.message });
      return respond(event, 500, {
        error: { code: "UPDATE_FAILED", message: "Failed to update transaction", traceId },
      });
    }
  }

  return respond(event, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported method for transactions", traceId },
  });
}

/**
 * Handle GET /accounts
 */
async function handleAccounts(event) {
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  const payload = await authenticate(event);
  const isDemo = isDemoUser(payload.sub);

  // Demo user - return generated demo accounts
  if (isDemo) {
    try {
      const demoAccounts = generateDemoAccounts(payload.sub);
      return respond(event, 200, { 
        accounts: demoAccounts, 
        traceId,
        isDemo: true 
      });
    } catch (error) {
      console.error("[accounts] demo generation failed", { message: error?.message });
      return respond(event, 500, {
        error: { code: "DEMO_GENERATION_FAILED", message: "Failed to generate demo accounts", traceId },
      });
    }
  }

  // Regular user - fetch from DB
  try {
    const accounts = await withUserClient(payload.sub, async (client) => {
      await ensureUserRow(client, payload);
      return queryAccountsWithClient(client);
    });
    return respond(event, 200, { accounts, traceId });
  } catch (error) {
    console.error("[accounts] fetch failed", { message: error?.message });
    return respond(event, 500, {
      error: { code: "FETCH_FAILED", message: "Failed to fetch accounts", traceId },
    });
  }
}

module.exports = {
  handleTransactions,
  handleAccounts,
};
