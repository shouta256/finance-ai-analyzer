"use strict";

const { buildResponse, resolveCorsOrigin } = require("../utils/response");
const { createHttpError, parseJsonBody, stripTrailingSlash } = require("../utils/helpers");
const { LEDGER_TIMEOUT_MS, UUID_REGEX } = require("../utils/constants");

const REQUEST_HEADER_BLOCKLIST = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "x-amzn-trace-id",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "cache-control",
  "x-chat-id",
  "x-request-trace",
]);

function normalisePrefix(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "";
}

function resolveLedgerBaseUrl() {
  const base =
    process.env.LEDGER_SERVICE_INTERNAL_URL ||
    process.env.LEDGER_SERVICE_URL ||
    process.env.NEXT_PUBLIC_LEDGER_BASE;
  if (!base) {
    throw createHttpError(500, "Ledger service base URL is not configured");
  }
  return stripTrailingSlash(base);
}

function buildLedgerUrl(pathWithQuery) {
  const base = resolveLedgerBaseUrl();
  const prefix = normalisePrefix(process.env.LEDGER_SERVICE_PATH_PREFIX);
  const [pathPart, queryPart] = pathWithQuery.split("?");
  const normalizedPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;

  try {
    const url = new URL(base);
    const basePath = url.pathname.replace(/\/+$/g, "");
    const prefixPath = prefix.replace(/\/+$/g, "");
    const needsPrefix = prefixPath && !basePath.endsWith(prefixPath);
    const finalPrefix = needsPrefix ? prefix : "";
    url.pathname = `${basePath}${finalPrefix}${normalizedPath}`.replace(/\/{2,}/g, "/");
    url.search = queryPart ? `?${queryPart}` : "";
    return url.toString();
  } catch {
    const needsPrefix = prefix && !base.endsWith(prefix);
    const finalPrefix = needsPrefix ? prefix : "";
    const fullPath = `${base}${finalPrefix}${normalizedPath}`.replace(/\/{2,}/g, "/");
    return queryPart ? `${fullPath}?${queryPart}` : fullPath;
  }
}

function buildForwardedHeaders(event) {
  const headers = new Headers();
  const sourceHeaders = event.headers || {};

  for (const [name, value] of Object.entries(sourceHeaders)) {
    if (value == null) continue;
    const normalizedName = name.toLowerCase();
    if (REQUEST_HEADER_BLOCKLIST.has(normalizedName)) continue;
    headers.set(normalizedName, String(value));
  }

  if (!headers.has("x-request-trace")) {
    const traceId = event.requestContext?.requestId;
    if (traceId) {
      headers.set("x-request-trace", traceId);
    }
  }

  return headers;
}

function extractBody(event, overrideBody) {
  if (overrideBody !== undefined) {
    return overrideBody;
  }
  if (!event.body) {
    return undefined;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
}

function buildQueryString(event) {
  if (typeof event.rawQueryString === "string" && event.rawQueryString.length > 0) {
    return event.rawQueryString;
  }

  const params = event.queryStringParameters || {};
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}

function collectResponseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.has(normalizedName)) {
      headers[name] = value;
    }
  }
  return headers;
}

function buildProxyPath(event, normalizedPath, overridePath) {
  const targetPath = overridePath || normalizedPath;
  const query = buildQueryString(event);
  return query ? `${targetPath}?${query}` : targetPath;
}

function rewriteTransactionPatch(event, normalizedPath) {
  if (normalizedPath !== "/transactions") {
    return { targetPath: normalizedPath, body: undefined };
  }

  const body = parseJsonBody(event);
  const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
  if (!UUID_REGEX.test(transactionId)) {
    throw createHttpError(400, "transactionId is required for PATCH /transactions compatibility");
  }

  const { transactionId: _ignored, ...payload } = body;
  return {
    targetPath: `/transactions/${transactionId}`,
    body: JSON.stringify(payload),
  };
}

async function proxyLedgerRequest(event, normalizedPath, options = {}) {
  const method = (
    event.requestContext?.http?.method ||
    event.httpMethod ||
    "GET"
  ).toUpperCase();
  const corsOrigin = resolveCorsOrigin(event);

  let targetPath = options.targetPath || normalizedPath;
  let bodyOverride = options.body;

  try {
    if (options.compatibilityMode === "transaction-patch") {
      const rewritten = rewriteTransactionPatch(event, normalizedPath);
      targetPath = rewritten.targetPath;
      bodyOverride = rewritten.body;
    }

    const targetUrl = buildLedgerUrl(buildProxyPath(event, normalizedPath, targetPath));
    const headers = buildForwardedHeaders(event);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body: extractBody(event, bodyOverride),
        signal: controller.signal,
      });
      const textBody = await response.text();
      let payload;
      if (textBody) {
        try {
          payload = JSON.parse(textBody);
        } catch {
          payload = { message: textBody };
        }
      }

      return buildResponse(response.status, payload, {
        headers: collectResponseHeaders(response),
        corsOrigin,
      });
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        return buildResponse(504, {
          error: {
            code: "LEDGER_TIMEOUT",
            message: "Ledger upstream request timed out",
          },
        }, { corsOrigin });
      }

      return buildResponse(502, {
        error: {
          code: "LEDGER_PROXY_FAILED",
          message: error?.message || "Ledger upstream request failed",
        },
      }, { corsOrigin });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return buildResponse(status, {
      error: {
        code: status === 400 ? "INVALID_REQUEST" : "LEDGER_PROXY_FAILED",
        message: error?.message || "Ledger upstream request failed",
      },
    }, { corsOrigin });
  }
}

module.exports = {
  proxyLedgerRequest,
};
