"use strict";

/**
 * Application-wide constants
 */

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-request-trace",
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes("*");

function normaliseOriginUrl(origin) {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

const NORMALISED_ALLOWED_ORIGINS = ALLOWED_ORIGINS.map(normaliseOriginUrl).filter(Boolean);

// Demo user configuration
const DEV_JWT_SECRET = process.env.SAFEPOCKET_DEV_JWT_SECRET || "dev-secret-key-for-local-development-only";
const DEV_USER_ID = process.env.DEV_USER_ID || "0f08d2b9-28b3-4b28-bd33-41a36161e9ab";
const DEV_LOGIN_ENABLED = ["true", "1", "yes"].includes(
  String(process.env.ENABLE_DEV_LOGIN || process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN || "true").toLowerCase()
);

// Timeouts
const PLAID_TIMEOUT_MS = Number(process.env.PLAID_TIMEOUT_MS || "8000");
const LEDGER_TIMEOUT_MS = Number(process.env.LEDGER_PROXY_TIMEOUT_MS || "8000");

// Chat configuration
const CHAT_SYSTEM_PROMPT =
  "You are Safepocket's financial helper. Use the provided context to answer. Context JSON includes 'summary' (month totals, top categories/merchants) and 'recentTransactions' (latest activity). Provide amounts in US dollars with sign-aware formatting, cite exact dates, and do not invent data beyond the supplied context.";
const CHAT_MAX_HISTORY_MESSAGES = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_HISTORY_LIMIT || "3", 10), 0);
const CHAT_HISTORY_CHAR_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_HISTORY_CHAR_LIMIT || "1200", 10), 200);
const CHAT_CONTEXT_CHAR_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_CONTEXT_LIMIT || "8000", 10), 2000);
const CHAT_DEFAULT_MAX_TOKENS = Math.max(Number.parseInt(process.env.SAFEPOCKET_AI_MAX_TOKENS || "1200", 10), 200);

// Highlight (AI Summary) configuration
const HIGHLIGHT_SYSTEM_PROMPT =
  "You are Safepocket's monthly finance analyst. Review the provided spending data and craft a short highlight. Respond with compact JSON that matches {\"title\": string, \"summary\": string, \"sentiment\": \"POSITIVE\"|\"NEUTRAL\"|\"NEGATIVE\", \"recommendations\": string[]}. Mention net cash flow, notable categories or merchants, and give 2-4 actionable, empathetic tips.";
const HIGHLIGHT_MAX_TOKENS = Math.max(Number.parseInt(process.env.SAFEPOCKET_HIGHLIGHT_MAX_TOKENS || "700", 10), 200);
const HIGHLIGHT_TRANSACTIONS_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_HIGHLIGHT_TX_LIMIT || "20", 10), 5);
const HIGHLIGHT_TOP_CATEGORY_LIMIT = 5;
const HIGHLIGHT_TOP_MERCHANT_LIMIT = 5;

// UUID regex for validation
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Time constants
const DAY_MS = 24 * 60 * 60 * 1000;

// Anonymous user
const ANON_USER_ID = process.env.ANON_USER_ID || "00000000-0000-0000-0000-000000000000";
const ADMIN_SQL_TOKEN = process.env.ADMIN_SQL_TOKEN || "";

module.exports = {
  RESPONSE_HEADERS,
  ALLOWED_ORIGINS,
  ALLOW_ANY_ORIGIN,
  NORMALISED_ALLOWED_ORIGINS,
  DEV_JWT_SECRET,
  DEV_USER_ID,
  DEV_LOGIN_ENABLED,
  PLAID_TIMEOUT_MS,
  LEDGER_TIMEOUT_MS,
  CHAT_SYSTEM_PROMPT,
  CHAT_MAX_HISTORY_MESSAGES,
  CHAT_HISTORY_CHAR_LIMIT,
  CHAT_CONTEXT_CHAR_LIMIT,
  CHAT_DEFAULT_MAX_TOKENS,
  HIGHLIGHT_SYSTEM_PROMPT,
  HIGHLIGHT_MAX_TOKENS,
  HIGHLIGHT_TRANSACTIONS_LIMIT,
  HIGHLIGHT_TOP_CATEGORY_LIMIT,
  HIGHLIGHT_TOP_MERCHANT_LIMIT,
  UUID_REGEX,
  DAY_MS,
  ANON_USER_ID,
  ADMIN_SQL_TOKEN,
  normaliseOriginUrl,
};
