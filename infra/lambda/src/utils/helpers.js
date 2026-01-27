"use strict";

const crypto = require("crypto");

/**
 * Create an HTTP error with status code
 */
function createHttpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

/**
 * Strip trailing slashes from a URL
 */
function stripTrailingSlash(value) {
  if (!value) return value;
  return value.replace(/\/+$/g, "");
}

/**
 * Ensure a URL has HTTPS prefix
 */
function ensureHttps(value) {
  if (!value) return value;
  return value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
}

/**
 * Generate a deterministic UUID from a value using SHA-256
 */
function hashToUuid(value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Execute a database operation within a savepoint for safe rollback
 */
async function withSavepoint(client, label, fn) {
  const name = `sp_${label}_${crypto.randomUUID().replace(/-/g, "")}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch((rollbackError) => 
      console.warn("[lambda] failed to rollback savepoint", { label, message: rollbackError?.message })
    );
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    throw error;
  }
}

/**
 * Parse JSON body from Lambda event
 */
function parseJsonBody(event) {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw createHttpError(400, "Invalid JSON body");
  }
}

/**
 * Parse month string (YYYY-MM) to Date object
 */
function parseMonth(value) {
  const [year, month] = value.split("-");
  const yy = Number.parseInt(year, 10);
  const mm = Number.parseInt(month, 10) - 1;
  if (!Number.isFinite(yy) || !Number.isFinite(mm)) {
    throw createHttpError(400, "Invalid month format (YYYY-MM)");
  }
  return new Date(Date.UTC(yy, mm, 1));
}

/**
 * Parse date range from query parameters
 */
function parseRange(query) {
  if (query.from && query.to) {
    const fromDate = parseMonth(query.from);
    const endDate = parseMonth(query.to);
    return {
      fromDate,
      toDate: new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 1)),
      monthLabel: null,
    };
  }
  if (query.month) {
    const start = parseMonth(query.month);
    return {
      fromDate: start,
      toDate: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      monthLabel: query.month,
    };
  }
  return {
    fromDate: new Date(Date.UTC(1970, 0, 1)),
    toDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    monthLabel: null,
  };
}

/**
 * Convert Date to ISO date string (YYYY-MM-DD)
 */
function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Round a number to 2 decimal places
 */
function round(value) {
  return Number.parseFloat(Number(value).toFixed(2));
}

/**
 * Format USD currency
 */
function formatUsd(value, options = {}) {
  const { absolute = false } = options;
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  const amount = absolute ? Math.abs(numeric) : numeric;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/**
 * Humanize a label (replace underscores/spaces, capitalize)
 */
function humaniseLabel(label) {
  if (!label) return "";
  return String(label)
    .replace(/[_\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse comma-separated list or return fallback
 */
function parseList(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value.length > 0 ? value : fallback;
  const parts = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

/**
 * Coerce a value to boolean
 */
function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

/**
 * Truncate text to a limit
 */
function truncateText(value, limit) {
  if (typeof value !== "string") return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[...truncated...]`;
}

/**
 * Check if auth is optional based on environment
 */
function isAuthOptional() {
  const v = String(
    process.env.AUTH_OPTIONAL ||
    process.env.NEXT_PUBLIC_AUTH_OPTIONAL ||
    ""
  ).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

module.exports = {
  createHttpError,
  stripTrailingSlash,
  ensureHttps,
  hashToUuid,
  withSavepoint,
  parseJsonBody,
  parseMonth,
  parseRange,
  toIsoDate,
  round,
  formatUsd,
  humaniseLabel,
  parseList,
  coerceBoolean,
  truncateText,
  isAuthOptional,
};
