"use strict";

const {
  RESPONSE_HEADERS,
  ALLOWED_ORIGINS,
  ALLOW_ANY_ORIGIN,
  NORMALISED_ALLOWED_ORIGINS,
} = require("./constants");

/**
 * Pick the preferred redirect origin (non-execute-api preferred)
 */
function pickPreferredRedirectOrigin() {
  const nonExecuteApi = NORMALISED_ALLOWED_ORIGINS.find((origin) => !/execute-api/i.test(origin));
  return nonExecuteApi || NORMALISED_ALLOWED_ORIGINS[0];
}

/**
 * Resolve CORS origin for the response
 */
function resolveCorsOrigin(event) {
  const originHeader = event.headers?.origin || event.headers?.Origin;
  if (!originHeader) {
    if (ALLOW_ANY_ORIGIN) return undefined;
    return ALLOWED_ORIGINS[0];
  }
  if (ALLOW_ANY_ORIGIN) {
    return originHeader;
  }
  const match = ALLOWED_ORIGINS.find((allowed) => allowed.toLowerCase() === originHeader.toLowerCase());
  return match ? originHeader : ALLOWED_ORIGINS[0];
}

/**
 * Build HTTP response with proper headers
 */
function buildResponse(statusCode, body, options = {}) {
  const { headers: extraHeaders = {}, cookies, corsOrigin } = options;
  const headers = { ...RESPONSE_HEADERS, ...extraHeaders };

  let originValue = corsOrigin;
  if (!originValue) {
    if (headers["Access-Control-Allow-Origin"]) {
      originValue = headers["Access-Control-Allow-Origin"];
    } else if (ALLOW_ANY_ORIGIN) {
      originValue = "*";
    } else if (ALLOWED_ORIGINS.length > 0) {
      originValue = ALLOWED_ORIGINS[0];
    }
  }
  if (originValue) {
    headers["Access-Control-Allow-Origin"] = originValue;
    if (originValue !== "*") {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }

  const response = {
    statusCode,
    headers,
    body: body === undefined || body === null ? "" : JSON.stringify(body),
  };
  if (Array.isArray(cookies) && cookies.length > 0) {
    response.cookies = cookies;
  }
  return response;
}

/**
 * Build response with CORS for event
 */
function respond(event, statusCode, body, options = {}) {
  return buildResponse(statusCode, body, { ...options, corsOrigin: resolveCorsOrigin(event) });
}

module.exports = {
  pickPreferredRedirectOrigin,
  resolveCorsOrigin,
  buildResponse,
  respond,
};
