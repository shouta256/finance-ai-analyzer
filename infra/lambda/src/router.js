"use strict";

/**
 * Safepocket Lambda Router
 * 
 * Single Lambda runtime implementation.
 *
 * Production still enters via `infra/lambda/index.js`, but that file is now a
 * thin shim. This router is the single runtime implementation and should remain slim:
 * routing only, with HTTP logic in `src/handlers/*` and business logic in
 * `src/services/*`.
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

const {
  handleAuthToken,
  handleAuthCallback,
  handleDevAuthLogin,
  handleDevAuthLogout,
  handleDiagnosticsAuth,
} = require("./handlers/auth");
const {
  handlePlaidLinkToken,
  handlePlaidExchange,
  handleTransactionsSync,
  handleTransactionsReset,
  handleDiagnosticsPlaidConfig,
} = require("./handlers/plaid");
const { handleAnalyticsSummary } = require("./handlers/analytics");
const { handleChat } = require("./handlers/chat");
const { handleTransactions, handleAccounts } = require("./handlers/transactions");
const {
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
} = require("./handlers/diagnostics");
const { isLedgerProxyConfigured, proxyLedgerRequest } = require("./handlers/proxy");

// Import utils
const { respond } = require("./utils/response");
const { SchemaNotMigratedError } = require("./bootstrap/schemaGuard");

let legacyLedgerFallbackWarned = false;

function logLegacyLedgerFallback(path) {
  if (legacyLedgerFallbackWarned) return;
  legacyLedgerFallbackWarned = true;
  console.warn("[lambda] ledger proxy env missing; using legacy Lambda handlers for domain routes", {
    path,
  });
}

function buildPatchedTransactionEvent(event, path) {
  const transactionId = path.split("/")[2];
  let parsedBody = {};

  if (event.body) {
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsedBody = {};
    }
  }

  return {
    ...event,
    rawPath: "/transactions",
    path: "/transactions",
    body: JSON.stringify({ ...parsedBody, transactionId }),
    isBase64Encoded: false,
  };
}

async function proxyOrFallback(event, normalizedPath, fallback, options = {}) {
  if (isLedgerProxyConfigured()) {
    return proxyLedgerRequest(event, normalizedPath, options);
  }
  logLegacyLedgerFallback(normalizedPath);
  return fallback();
}

async function proxyOnly(event, normalizedPath, code = "LEDGER_PROXY_NOT_CONFIGURED", message = "This route requires a configured ledger service upstream.") {
  if (isLedgerProxyConfigured()) {
    return proxyLedgerRequest(event, normalizedPath);
  }
  return respond(event, 501, {
    error: {
      code,
      message,
    },
  });
}

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

    // === Domain routes (proxy mode or standalone fallback) ===
    if (path === "/ai/chat") {
      return await proxyOrFallback(event, path, () => handleChat(event));
    }

    if (method === "GET" && path === "/analytics/summary") {
      return await proxyOrFallback(event, path, () => handleAnalyticsSummary(event));
    }

    if (method === "GET" && path === "/transactions") {
      return await proxyOrFallback(event, path, () => handleTransactions(event));
    }
    if (method === "PATCH" && path === "/transactions") {
      return await proxyOrFallback(
        event,
        path,
        () => handleTransactions(event),
        { compatibilityMode: "transaction-patch" },
      );
    }
    if (method === "PATCH" && /^\/transactions\/[0-9a-fA-F-]{36}$/.test(path)) {
      return await proxyOrFallback(event, path, () => handleTransactions(buildPatchedTransactionEvent(event, path)));
    }
    if (method === "POST" && path === "/transactions/sync") {
      return await proxyOrFallback(event, path, () => handleTransactionsSync(event));
    }
    if (method === "POST" && path === "/transactions/reset") {
      return await proxyOrFallback(event, path, () => handleTransactionsReset(event));
    }

    if (method === "GET" && path === "/accounts") {
      return await proxyOrFallback(event, path, () => handleAccounts(event));
    }

    if (method === "POST" && path === "/plaid/link-token") {
      return await proxyOrFallback(event, path, () => handlePlaidLinkToken(event));
    }
    if (method === "POST" && path === "/plaid/exchange") {
      return await proxyOrFallback(event, path, () => handlePlaidExchange(event));
    }

    if (method === "POST" && path === "/rag/search") {
      return await proxyOnly(event, path, "RAG_STANDALONE_UNAVAILABLE", "RAG endpoints require ledger-svc in proxy mode. Standalone Lambda mode uses built-in chat retrieval only.");
    }
    if (method === "GET" && path === "/rag/summaries") {
      return await proxyOnly(event, path, "RAG_STANDALONE_UNAVAILABLE", "RAG endpoints require ledger-svc in proxy mode. Standalone Lambda mode uses built-in chat retrieval only.");
    }
    if (method === "POST" && path === "/rag/aggregate") {
      return await proxyOnly(event, path, "RAG_STANDALONE_UNAVAILABLE", "RAG endpoints require ledger-svc in proxy mode. Standalone Lambda mode uses built-in chat retrieval only.");
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
