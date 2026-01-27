"use strict";

/**
 * Safepocket Lambda Router
 * 
 * Clean modular router that delegates all business logic to specialized handlers.
 * This file should remain slim - only routing logic.
 */

require("./bootstrap/fetch-debug");

const crypto = require("crypto");

// Ensure crypto.randomUUID exists (Node 14.17+ polyfill)
if (typeof crypto.randomUUID !== "function") {
  const { randomBytes } = crypto;
  crypto.randomUUID = function randomUUID() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

// Import handlers
const {
  // Auth
  handleAuthToken,
  handleAuthCallback,
  handleDevAuthLogin,
  handleDevAuthLogout,
  handleDiagnosticsAuth,
  // Plaid
  handlePlaidLinkToken,
  handlePlaidExchange,
  handleDiagnosticsPlaidConfig,
  // Analytics
  handleAnalyticsSummary,
  // Chat
  handleChat,
  // Transactions
  handleTransactions,
  handleTransactionsSync,
  handleTransactionsReset,
  handleAccounts,
  // Diagnostics
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
} = require("./handlers");

// Import utils
const { respond } = require("./utils/response");
const { SchemaNotMigratedError } = require("./bootstrap/schemaGuard");

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
  try {
    const method = (
      event.requestContext?.http?.method ||
      event.httpMethod ||
      "GET"
    ).toUpperCase();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return respond(event, 204, "");
    }

    // Normalize path
    const stage = event.requestContext?.stage
      ? `/${event.requestContext.stage}`
      : "";
    let rawPath = event.rawPath || event.path || "/";
    if (stage && rawPath.startsWith(stage)) {
      rawPath = rawPath.slice(stage.length) || "/";
    }
    const path = rawPath.replace(/\/+/g, "/");

    // === Health checks ===
    if (method === "GET" && (path === "/" || path === "")) {
      return respond(event, 200, { status: "ok" });
    }
    if (method === "GET" && path === "/health") {
      return respond(event, 200, { status: "ok" });
    }

    // === Auth routes ===
    if (method === "POST" && path === "/auth/token") {
      return await handleAuthToken(event);
    }
    if (method === "GET" && path === "/auth/callback") {
      return await handleAuthCallback(event);
    }
    if (method === "POST" && path === "/dev/auth/login") {
      return await handleDevAuthLogin(event);
    }
    if (method === "POST" && path === "/dev/auth/logout") {
      return await handleDevAuthLogout(event);
    }

    // === Chat routes (all methods) ===
    if (path === "/chat" || path === "/api/chat" || path === "/ai/chat") {
      return await handleChat(event);
    }

    // === Analytics routes ===
    if (method === "GET" && path === "/analytics/summary") {
      return await handleAnalyticsSummary(event);
    }

    // === Transaction routes ===
    if ((method === "GET" || method === "PATCH") && path === "/transactions") {
      return await handleTransactions(event);
    }
    if (method === "POST" && path === "/transactions/sync") {
      return await handleTransactionsSync(event);
    }
    if (method === "POST" && path === "/transactions/reset") {
      return await handleTransactionsReset(event);
    }

    // === Account routes ===
    if (method === "GET" && path === "/accounts") {
      return await handleAccounts(event);
    }

    // === Plaid routes ===
    if (method === "POST" && path === "/plaid/link-token") {
      return await handlePlaidLinkToken(event);
    }
    if (method === "POST" && path === "/plaid/exchange") {
      return await handlePlaidExchange(event);
    }

    // === Diagnostics routes ===
    if (method === "GET" && path === "/diagnostics/dns") {
      return await handleDnsDiagnostics(event);
    }
    if (path === "/diagnostics/auth") {
      return await handleDiagnosticsAuth(event);
    }
    if (path === "/diagnostics/db/plaid-items") {
      return await handleDiagnosticsPlaidItems(event);
    }
    if (method === "GET" && path === "/diagnostics/plaid-config") {
      return await handleDiagnosticsPlaidConfig(event);
    }
    if (method === "POST" && path === "/diagnostics/db/maint") {
      return await handleDiagnosticsDbMaintenance(event);
    }

    // === Admin routes ===
    if (method === "POST" && path === "/admin/db/plaid-items/ensure-constraints") {
      return await handleAdminEnsureConstraints(event);
    }

    // === 404 ===
    return respond(event, 404, { error: "Not Found" });
  } catch (error) {
    console.error("[lambda] handler error", error);
    
    const timeoutTriggered = error?.code === "DB_OPERATION_TIMEOUT";
    const isSchemaError = error instanceof SchemaNotMigratedError;
    
    const status = timeoutTriggered
      ? 504
      : error?.statusCode || error?.status || 500;
    
    const code = timeoutTriggered
      ? "DB_TIMEOUT"
      : isSchemaError
        ? "DB_SCHEMA_NOT_READY"
        : "LAMBDA_ERROR";

    return respond(event, status, {
      error: {
        code,
        message: error?.message || "Internal Server Error",
      },
    });
  }
};
