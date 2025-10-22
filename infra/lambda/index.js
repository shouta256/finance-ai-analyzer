"use strict";

require("./src/bootstrap/fetch-debug");

const crypto = require("crypto");
let CognitoJwtVerifier;
try {
  ({ CognitoJwtVerifier } = require("aws-jwt-verify"));
} catch (error) {
  console.warn("[lambda] aws-jwt-verify module not found. Install the layer to enable Cognito JWT verification.", {
    message: error?.message,
  });
}
if (typeof crypto.randomUUID !== "function") {
  const { randomBytes } = crypto;
  crypto.randomUUID = function randomUUID() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // v4 UUID
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
const AWS = require("aws-sdk");
const dns = require("dns").promises;
const secretsManager = new AWS.SecretsManager();
const { withUserClient } = require("./src/db/pool");
const { SchemaNotMigratedError } = require("./src/bootstrap/schemaGuard");

const SECRET_COGNITO = process.env.SECRET_COGNITO_NAME || "/safepocket/cognito";
const SECRET_PLAID = process.env.SECRET_PLAID_NAME || "/safepocket/plaid";
const LEDGER_BASE_URL =
  process.env.LEDGER_SERVICE_INTERNAL_URL ||
  process.env.LEDGER_SERVICE_URL ||
  process.env.NEXT_PUBLIC_LEDGER_BASE;
const LEDGER_PATH_PREFIX = process.env.LEDGER_SERVICE_PATH_PREFIX || "";

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
const ENABLE_STUBS = (process.env.SAFEPOCKET_ENABLE_STUBS || "false").toLowerCase() === "true";

let configPromise;
const cognitoVerifierCache = new Map();

function stripTrailingSlash(value) {
  if (!value) return value;
  return value.replace(/\/+$/g, "");
}

function ensureHttps(value) {
  if (!value) return value;
  return value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

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

function respond(event, statusCode, body, options = {}) {
  return buildResponse(statusCode, body, { ...options, corsOrigin: resolveCorsOrigin(event) });
}

function buildResponse(statusCode, body, options = {}) {
  const { headers: extraHeaders = {}, cookies, corsOrigin } = options;
  const headers = { ...RESPONSE_HEADERS, ...extraHeaders };

  let originValue = corsOrigin;
  if (!originValue) {
    if (headers["Access-Control-Allow-Origin"]) {
      originValue = headers["Access-Control-Allow-Origin"]; // respect caller override
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

async function fetchSecret(name) {
  if (!name) return undefined;
  try {
    const res = await secretsManager.getSecretValue({ SecretId: name }).promise();
    const str = res.SecretString ?? Buffer.from(res.SecretBinary, "base64").toString("utf8");
    return JSON.parse(str);
  } catch (error) {
    console.warn(`[lambda] failed to read secret ${name}: ${error.message}`);
    return undefined;
  }
}

async function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    const [cognitoSecret, plaidSecret] = await Promise.all([
      fetchSecret(SECRET_COGNITO),
      fetchSecret(SECRET_PLAID),
    ]);

    const cognitoDomain =
      process.env.COGNITO_DOMAIN ||
      process.env.NEXT_PUBLIC_COGNITO_DOMAIN ||
      cognitoSecret?.domain;
    const cognitoClientId =
      process.env.COGNITO_CLIENT_ID ||
      process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ||
      cognitoSecret?.clientId ||
      cognitoSecret?.client_id;
    const cognitoClientSecret =
      process.env.COGNITO_CLIENT_SECRET || cognitoSecret?.clientSecret || cognitoSecret?.client_secret;
    const cognitoRedirectUri =
      process.env.COGNITO_REDIRECT_URI ||
      process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI ||
      cognitoSecret?.redirectUri ||
      cognitoSecret?.redirect_uri;
    const cognitoRegion =
      process.env.COGNITO_REGION || cognitoSecret?.region || cognitoSecret?.regionId || cognitoSecret?.region_id;
    let cognitoIssuer = process.env.COGNITO_ISSUER || cognitoSecret?.issuer;
    const cognitoAudience =
      process.env.COGNITO_AUDIENCE || cognitoSecret?.audience || cognitoClientId || cognitoSecret?.clientId;
    let cognitoUserPoolId =
      process.env.COGNITO_USER_POOL_ID ||
      cognitoSecret?.userPoolId ||
      cognitoSecret?.user_pool_id ||
      (cognitoIssuer ? cognitoIssuer.split("/").pop() : undefined);

    const derivedRegion =
      cognitoRegion ||
      (cognitoUserPoolId && cognitoUserPoolId.includes("_") ? cognitoUserPoolId.split("_")[0] : undefined);
    if (!cognitoIssuer && derivedRegion && cognitoUserPoolId) {
      cognitoIssuer = `https://cognito-idp.${derivedRegion}.amazonaws.com/${cognitoUserPoolId}`;
    }
    if (!cognitoUserPoolId && cognitoIssuer) {
      cognitoUserPoolId = cognitoIssuer.split("/").pop();
    }
    const cognitoJwksUrl =
      process.env.COGNITO_JWKS_URL ||
      cognitoSecret?.jwksUrl ||
      (cognitoDomain ? `${stripTrailingSlash(ensureHttps(cognitoDomain))}/.well-known/jwks.json` : undefined);

    const plaidEnv = process.env.PLAID_ENV || plaidSecret?.env || plaidSecret?.environment || "sandbox";
    const normalizeString = (value) =>
      typeof value === "string" ? value.trim() : value;
    const plaidConfig = {
      clientId: normalizeString(
        process.env.PLAID_CLIENT_ID ||
          plaidSecret?.clientId ||
          plaidSecret?.client_id,
      ),
      clientSecret: normalizeString(
        process.env.PLAID_CLIENT_SECRET ||
          process.env.PLAID_SECRET ||
          plaidSecret?.clientSecret ||
          plaidSecret?.client_secret ||
          plaidSecret?.secret,
      ),
      env: plaidEnv,
      baseUrl:
        process.env.PLAID_BASE_URL ||
        plaidSecret?.baseUrl ||
        (plaidEnv === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com"),
      products:
        process.env.PLAID_PRODUCTS ||
        plaidSecret?.products ||
        "transactions",
      countryCodes:
        process.env.PLAID_COUNTRY_CODES ||
        plaidSecret?.countryCodes ||
        "US",
      redirectUri:
        process.env.PLAID_REDIRECT_URI ||
        plaidSecret?.redirectUri ||
        "",
      webhookUrl:
        process.env.PLAID_WEBHOOK_URL ||
        plaidSecret?.webhookUrl ||
        "",
      webhookSecret:
        process.env.PLAID_WEBHOOK_SECRET ||
        plaidSecret?.webhookSecret ||
        "",
      clientName:
        process.env.PLAID_CLIENT_NAME ||
        plaidSecret?.clientName ||
        "Safepocket",
    };

    return {
      cognito: {
        domain: stripTrailingSlash(ensureHttps(cognitoDomain)),
        clientId: cognitoClientId,
        clientSecret: cognitoClientSecret,
        redirectUri: cognitoRedirectUri,
        issuer: cognitoIssuer,
        userPoolId: cognitoUserPoolId,
        region: derivedRegion,
        audienceList: (cognitoAudience || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        jwksUrl: cognitoJwksUrl,
      },
      plaid: plaidConfig,
    };
  })();
  return configPromise;
}

function normaliseClientIds(ids) {
  if (!Array.isArray(ids)) return undefined;
  const unique = Array.from(new Set(ids.filter((value) => typeof value === "string" && value.trim().length > 0)));
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0] : unique;
}

function getCognitoVerifiers(cognito) {
  if (!CognitoJwtVerifier) {
    throw createHttpError(500, "aws-jwt-verify module not available");
  }
  if (!cognito.userPoolId) {
    throw createHttpError(500, "Cognito userPoolId not configured");
  }
  const clientIdOption = normaliseClientIds(cognito.audienceList);
  const cacheKey = JSON.stringify({
    pool: cognito.userPoolId,
    clientId: clientIdOption,
  });
  let entry = cognitoVerifierCache.get(cacheKey);
  if (!entry) {
    const baseOptions = clientIdOption ? { clientId: clientIdOption } : {};
    entry = {
      id: CognitoJwtVerifier.create({
        userPoolId: cognito.userPoolId,
        tokenUse: "id",
        ...baseOptions,
      }),
      access: CognitoJwtVerifier.create({
        userPoolId: cognito.userPoolId,
        tokenUse: "access",
        ...baseOptions,
      }),
    };
    cognitoVerifierCache.set(cacheKey, entry);
  }
  return entry;
}

function parseCookies(event) {
  const cookieHeader = event.headers?.cookie || event.headers?.Cookie;
  const cookies = event.cookies || (cookieHeader ? cookieHeader.split(";") : []);
  const map = new Map();
  if (Array.isArray(cookies)) {
    cookies.forEach((cookie) => {
      const [name, ...rest] = cookie.split("=");
      if (!name) return;
      map.set(name.trim(), rest.join("=").trim());
    });
  }
  return map;
}

function extractAuthorizationHeader(event) {
  const headers = event.headers || {};
  const raw = headers.authorization || headers.Authorization;
  if (raw && raw.trim()) {
    return raw.startsWith("Bearer ") ? raw.trim() : `Bearer ${raw.trim()}`;
  }
  const cookies = parseCookies(event);
  const token = cookies.get("sp_token");
  if (token && token.trim()) {
    return `Bearer ${token.trim()}`;
  }
  return null;
}

async function authenticate(event) {
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  let token = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    const cookies = parseCookies(event);
    token = cookies.get("sp_token");
  }
  if (!token) throw createHttpError(401, "Unauthorized");
  return verifyJwt(token);
}

async function verifyJwt(token) {
  const { cognito } = await loadConfig();
  const verifiers = getCognitoVerifiers(cognito);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw createHttpError(401, "Malformed JWT");
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw createHttpError(401, "Malformed JWT");
  }
  const preferredOrder = decoded?.token_use === "access" ? ["access", "id"] : ["id", "access"];
  let lastError;
  for (const kind of preferredOrder) {
    try {
      const verifier = kind === "access" ? verifiers.access : verifiers.id;
      const verified = await verifier.verify(token);
      if (cognito.issuer && verified?.iss !== cognito.issuer) {
        throw createHttpError(401, "Issuer mismatch");
      }
      if (!verified?.sub) {
        throw createHttpError(401, "Token missing subject");
      }
      return verified;
    } catch (error) {
      lastError = error;
    }
  }
  const handledError =
    lastError && typeof lastError === "object" && "statusCode" in lastError && typeof lastError.statusCode === "number"
      ? lastError
      : null;
  if (handledError) {
    throw handledError;
  }
  throw createHttpError(401, "Token verification failed");
}

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

function parseMonth(value) {
  const [year, month] = value.split("-");
  const yy = Number.parseInt(year, 10);
  const mm = Number.parseInt(month, 10) - 1;
  if (!Number.isFinite(yy) || !Number.isFinite(mm)) {
    throw createHttpError(400, "Invalid month format (YYYY-MM)");
  }
  return new Date(Date.UTC(yy, mm, 1));
}

function parseRange(query) {
  if (query.month) {
    const start = parseMonth(query.month);
    return {
      fromDate: start,
      toDate: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      monthLabel: query.month,
    };
  }
  if (query.from && query.to) {
    const fromDate = parseMonth(query.from);
    const endDate = parseMonth(query.to);
    return {
      fromDate,
      toDate: new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 1)),
      monthLabel: null,
    };
  }
  return {
    fromDate: new Date(Date.UTC(1970, 0, 1)),
    toDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    monthLabel: null,
  };
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function round(value) {
  return Number.parseFloat(Number(value).toFixed(2));
}

async function queryTransactions(userId, fromDate, toDate) {
  const res = await withUserClient(userId, (client) =>
    client.query(
      `SELECT t.id,
              t.user_id,
              t.account_id,
              m.name AS merchant_name,
              t.amount::numeric,
              t.currency,
              t.occurred_at AT TIME ZONE 'UTC' AS occurred_at,
              t.authorized_at AT TIME ZONE 'UTC' AS authorized_at,
              t.pending,
              t.category,
              t.description
       FROM transactions t
       JOIN merchants m ON t.merchant_id = m.id
       WHERE t.user_id = current_setting('appsec.user_id', true)::uuid
         AND t.occurred_at >= $1
         AND t.occurred_at < $2
       ORDER BY t.occurred_at DESC`,
      [fromDate.toISOString(), toDate.toISOString()],
    ),
  );
  return res.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    merchantName: row.merchant_name,
    amount: Number(row.amount),
    currency: row.currency,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    authorizedAt:
      row.authorized_at instanceof Date && !Number.isNaN(row.authorized_at.getTime())
        ? row.authorized_at.toISOString()
        : row.authorized_at,
    pending: row.pending,
    category: row.category,
    description: row.description,
    anomalyScore: null,
    notes: null,
  }));
}

function summarise(transactions, fromDate, toDate, monthLabel, traceId) {
  let income = 0;
  let expense = 0;
  const categoryTotals = new Map();
  const merchantTotals = new Map();
  const monthNet = {};

  transactions.forEach((tx) => {
    const amt = Number(tx.amount);
    if (amt > 0) income += amt;
    if (amt < 0) expense += amt;

    const category = tx.category || "Uncategorized";
    if (!categoryTotals.has(category)) categoryTotals.set(category, 0);
    if (amt < 0) categoryTotals.set(category, categoryTotals.get(category) + amt);

    const merchant = tx.merchantName || "Unknown";
    if (!merchantTotals.has(merchant)) merchantTotals.set(merchant, { total: 0, count: 0 });
    const stats = merchantTotals.get(merchant);
    stats.total += amt;
    stats.count += 1;

    const monthKey = tx.occurredAt.slice(0, 7);
    monthNet[monthKey] = round((monthNet[monthKey] || 0) + amt);
  });

  const totalExpenses = Array.from(categoryTotals.values()).reduce((sum, value) => sum + Math.abs(value), 0);
  const categories = Array.from(categoryTotals.entries())
    .map(([category, amount]) => ({
      category,
      amount: round(amount),
      percentage: totalExpenses === 0 ? 0 : round((Math.abs(amount) / totalExpenses) * 100),
    }))
    .filter((entry) => entry.amount < 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 8);

  const merchants = Array.from(merchantTotals.entries())
    .map(([merchant, stats]) => ({
      merchant,
      amount: round(stats.total),
      transactionCount: stats.count,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5);

  const net = income + expense;
  const cycleStart = new Date(fromDate);
  const cycleEnd = new Date(toDate.getTime() - 1);
  const today = new Date();
  const daysRemaining = Math.max(1, Math.ceil((cycleEnd.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)));
  const variableBudget = round(Math.abs(expense));

  return {
    month: monthLabel || toIsoDate(cycleStart).slice(0, 7),
    totals: { income: round(income), expense: round(expense), net: round(net) },
    byCategory: categories,
    topMerchants: merchants,
    anomalies: [],
    aiHighlight: {
      title: "Summary unavailable",
      summary: "AI-powered highlights are not enabled yet.",
      sentiment: "NEUTRAL",
      recommendations: ["Verify account sync", "Review categories if needed"],
    },
    safeToSpend: {
      cycleStart: toIsoDate(cycleStart),
      cycleEnd: toIsoDate(cycleEnd),
      safeToSpendToday: round(net > 0 ? net / daysRemaining : 0),
      hardCap: round(net > 0 ? net : 0),
      dailyBase: daysRemaining > 0 ? round(Math.abs(expense) / daysRemaining) : 0,
      dailyAdjusted: daysRemaining > 0 ? round(Math.abs(expense) / daysRemaining) : 0,
      rollToday: 0,
      paceRatio: 1,
      adjustmentFactor: 1,
      daysRemaining,
      variableBudget,
      variableSpent: variableBudget,
      remainingVariableBudget: 0,
      danger: net <= 0,
      notes: [],
    },
    traceId,
  };
}

function buildStubTransactions(userId, fromDate, toDate) {
  const baseDate = new Date(fromDate);
  const occurred = new Date(baseDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const authorized = new Date(baseDate.getTime() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
  const accountId = crypto.randomUUID();
  return [
    {
      id: crypto.randomUUID(),
      userId,
      accountId,
      merchantName: "Blue Bottle Coffee",
      amount: -8.75,
      currency: "USD",
      occurredAt: occurred,
      authorizedAt: authorized,
      pending: false,
      category: "Dining",
      description: "Latte",
      notes: null,
      anomalyScore: null,
    },
    {
      id: crypto.randomUUID(),
      userId,
      accountId,
      merchantName: "Whole Foods Market",
      amount: -54.32,
      currency: "USD",
      occurredAt: new Date(baseDate.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      authorizedAt: new Date(baseDate.getTime() + 5 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(),
      pending: false,
      category: "Groceries",
      description: "Weekly groceries",
      notes: null,
      anomalyScore: null,
    },
    {
      id: crypto.randomUUID(),
      userId,
      accountId,
      merchantName: "Acme Corp Payroll",
      amount: 3200.0,
      currency: "USD",
      occurredAt: new Date(baseDate.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      authorizedAt: new Date(baseDate.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      pending: false,
      category: "Income",
      description: "Monthly salary",
      notes: null,
      anomalyScore: null,
    },
  ];
}

function buildStubAccounts(userId) {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      name: "Everyday Checking",
      institution: "Sample Bank",
      balance: 2485.12,
      currency: "USD",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Rewards Credit",
      institution: "Sample Card Co.",
      balance: -432.44,
      currency: "USD",
      createdAt: now,
    },
  ];
}

function buildStubChatResponse(conversationId, userMessage) {
  const convoId = conversationId || crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const assistantCreated = new Date(now.getTime() + 1500).toISOString();
  const messages = [];
  if (userMessage) {
    messages.push({
      id: crypto.randomUUID(),
      role: "USER",
      content: userMessage,
      createdAt,
    });
  } else {
    messages.push({
      id: crypto.randomUUID(),
      role: "USER",
      content: "Can you summarize my spending this month?",
      createdAt,
    });
  }
  messages.push({
    id: crypto.randomUUID(),
    role: "ASSISTANT",
    content:
      "Here’s a quick look: income was $3,200, expenses $1,245 (groceries $420, dining $185, transportation $96). You’re tracking under budget, so keep up the good work!",
    createdAt: assistantCreated,
  });
  return {
    conversationId: convoId,
    messages,
    traceId: crypto.randomUUID(),
  };
}

function buildTransactionsAggregates(transactions) {
  let income = 0;
  let expense = 0;
  const monthNet = {};
  const categoryTotals = {};

  transactions.forEach((tx) => {
    const amt = Number(tx.amount);
    if (amt > 0) income += amt;
    if (amt < 0) {
      expense += amt;
      categoryTotals[tx.category] = round((categoryTotals[tx.category] || 0) + amt);
    }
    const monthKey = tx.occurredAt.slice(0, 7);
    monthNet[monthKey] = round((monthNet[monthKey] || 0) + amt);
  });

  return {
    incomeTotal: round(income),
    expenseTotal: round(expense),
    netTotal: round(income + expense),
    monthNet,
    categoryTotals,
    count: transactions.length,
  };
}

async function handleAnalyticsSummary(event, query) {
  const payload = await authenticate(event);
  const { fromDate, toDate, monthLabel } = parseRange(query);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  let transactions;
  let usingStub = false;
  try {
    transactions = await queryTransactions(payload.sub, fromDate, toDate);
  } catch (error) {
    if (!ENABLE_STUBS) throw error;
    console.warn("[lambda] analytics summary fallback", { message: error.message });
    transactions = buildStubTransactions(payload.sub, fromDate, toDate);
    usingStub = true;
  }
  const summary = summarise(transactions, fromDate, toDate, monthLabel, traceId);
  return respond(
    event,
    200,
    summary,
    usingStub ? { headers: { "x-safepocket-origin": "stub" } } : undefined,
  );
}

async function handleTransactions(event, query) {
  const payload = await authenticate(event);
  const { fromDate, toDate, monthLabel } = parseRange(query);
  let transactions;
  let usingStub = false;
  try {
    transactions = await queryTransactions(payload.sub, fromDate, toDate);
  } catch (error) {
    if (!ENABLE_STUBS) throw error;
    console.warn("[lambda] transactions fallback", { message: error.message });
    transactions = buildStubTransactions(payload.sub, fromDate, toDate);
    usingStub = true;
  }
  const page = Math.max(parseInt(query.page || "0", 10), 0);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize || "15", 10), 1), 100);
  const start = page * pageSize;
  const paged = transactions.slice(start, start + pageSize);
  return respond(
    event,
    200,
    {
      transactions: paged,
      period: {
        month: monthLabel,
        from: monthLabel ? null : toIsoDate(fromDate),
        to: monthLabel ? null : toIsoDate(new Date(toDate.getTime() - 1)),
      },
      aggregates: buildTransactionsAggregates(transactions),
      traceId: event.requestContext?.requestId || crypto.randomUUID(),
    },
    usingStub ? { headers: { "x-safepocket-origin": "stub" } } : undefined,
  );
}

async function handleAccounts(event) {
  const payload = await authenticate(event);
  let accounts;
  let usingStub = false;
  try {
    accounts = await withUserClient(payload.sub, async (client) => {
      const res = await client.query(
        `SELECT a.id,
                a.name,
                a.institution,
                a.created_at AT TIME ZONE 'UTC' AS created_at,
                COALESCE(SUM(t.amount::numeric), 0) AS balance
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.user_id = current_setting('appsec.user_id', true)::uuid
         GROUP BY a.id
         ORDER BY a.created_at DESC`,
      );
      return res.rows.map((row) => ({
        id: row.id,
        name: row.name,
        institution: row.institution,
        balance: round(row.balance),
        currency: "USD",
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }));
    });
  } catch (error) {
    if (!ENABLE_STUBS) throw error;
    console.warn("[lambda] accounts fallback", { message: error.message });
    accounts = buildStubAccounts(payload.sub);
    usingStub = true;
  }
  return respond(
    event,
    200,
    {
      accounts,
      traceId: event.requestContext?.requestId || crypto.randomUUID(),
    },
    usingStub ? { headers: { "x-safepocket-origin": "stub" } } : undefined,
  );
}

function parseList(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value.length > 0 ? value : fallback;
  const parts = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

async function handlePlaidLinkToken(event) {
function buildLedgerUrl(path) {
  if (!LEDGER_BASE_URL) {
    throw createHttpError(500, "Ledger service base URL is not configured");
  }
  const prefix = LEDGER_PATH_PREFIX ? `/${LEDGER_PATH_PREFIX.replace(/^\/+|\/+$/g, "")}` : "";
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${LEDGER_BASE_URL.replace(/\/+$/, "")}${prefix}${normalisedPath}`;
}

async function fetchLedgerJson(path, options = {}) {
  const url = buildLedgerUrl(path);
  const res = await fetch(url, options);
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err = createHttpError(res.status, typeof payload === "string" ? payload : (payload?.error?.message || payload?.message || "Ledger service request failed"));
    err.payload = payload;
    throw err;
  }
  return { status: res.status, payload: payload ?? {} };
}

async function handlePlaidLinkToken(event) {
  await authenticate(event);
  const authorization = extractAuthorizationHeader(event);
  if (!authorization) {
    return respond(event, 401, { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
  }
  try {
    const { status, payload } = await fetchLedgerJson("/plaid/link-token", {
      method: "POST",
      headers: {
        authorization: authorization,
      },
    });
    return respond(event, status, {
      linkToken: payload.linkToken ?? payload.link_token,
      expiration: payload.expiration,
      requestId: payload.requestId ?? payload.request_id ?? null,
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "PLAID_LINK_TOKEN_FAILED",
        message: error?.message || "Failed to create Plaid link token",
        details: error?.payload,
      },
    });
  }
}

async function handlePlaidExchange(event) {
  await authenticate(event);
  let body = {};
  try {
    body = parseJsonBody(event);
  } catch {
    return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } });
  }
  const publicToken = body.publicToken || body.public_token;
  if (!publicToken || typeof publicToken !== "string") {
    return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "publicToken is required" } });
  }
  const authorization = extractAuthorizationHeader(event);
  if (!authorization) {
    return respond(event, 401, { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
  }
  try {
    const { status, payload } = await fetchLedgerJson("/plaid/exchange", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ publicToken }),
    });
    return respond(event, status, {
      itemId: payload.itemId ?? payload.item_id,
      status: payload.status ?? "SUCCESS",
      requestId: payload.traceId ?? payload.requestId ?? null,
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "PLAID_EXCHANGE_FAILED",
        message: error?.message || "Failed to exchange Plaid public token",
        details: error?.payload,
      },
    });
  }
}

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

async function handleAuthToken(event) {
  const body = parseJsonBody(event);
  const grantType = body.grantType || body.grant_type;
  console.info("[/auth/token] request received", {
    grantType,
    hasCode: Boolean(body.code),
    hasCodeVerifier: Boolean(body.codeVerifier),
    hasRefreshToken: Boolean(body.refreshToken),
  });
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    throw createHttpError(400, "grantType must be authorization_code or refresh_token");
  }
  const config = await loadConfig();
  const { cognito } = config;
  if (!cognito.domain || !cognito.clientId) {
    throw createHttpError(500, "Cognito configuration missing");
  }

  const params = new URLSearchParams();
  params.set("grant_type", grantType);
  params.set("client_id", cognito.clientId);
  if (grantType === "authorization_code") {
    if (!body.code) throw createHttpError(400, "code is required for authorization_code");
    const redirectUri = body.redirectUri || cognito.redirectUri;
    if (!redirectUri) throw createHttpError(400, "redirectUri is required");
    params.set("code", body.code);
    params.set("redirect_uri", redirectUri);
    if (body.codeVerifier) params.set("code_verifier", body.codeVerifier);
    console.log("[lambda] token exchange request", {
      redirectUri,
      hasCodeVerifier: Boolean(body.codeVerifier),
      hasClientSecret: Boolean(cognito.clientSecret && cognito.clientSecret.trim()),
      domain: cognito.domain,
    });
  } else {
    if (!body.refreshToken) throw createHttpError(400, "refreshToken is required for refresh_token");
    params.set("refresh_token", body.refreshToken);
  }

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cognito.clientSecret && cognito.clientSecret.trim()) {
    headers.Authorization = `Basic ${Buffer.from(`${cognito.clientId}:${cognito.clientSecret}`).toString("base64")}`;
  }

  const tokenUrl = `${cognito.domain}/oauth2/token`;
  console.log("[lambda] token exchange request", {
    tokenUrl,
    grantType,
    hasClientSecret: Boolean(cognito.clientSecret && cognito.clientSecret.trim()),
    redirectUri: params.get("redirect_uri"),
  });
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    console.error("[lambda] Cognito token exchange failed", {
      status: resp.status,
      body: text,
    });
    throw createHttpError(resp.status, text || "Token exchange failed");
  }
  const json = text ? JSON.parse(text) : {};
  if (!json.access_token && !json.id_token) throw createHttpError(502, "Cognito response missing tokens");
  return respond(event, 200, {
    accessToken: json.access_token,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    tokenType: json.token_type,
    scope: json.scope,
  });
}

async function handleAuthCallback(event) {
  const query = event.queryStringParameters || {};
  const code = query.code;
  if (!code) {
    throw createHttpError(400, "Authorization code missing from query string");
  }

  const wantsJson =
    (query.response && query.response.toLowerCase() === "json") ||
    (query.format && query.format.toLowerCase() === "json") ||
    (event.headers?.accept || event.headers?.Accept || "").includes("application/json");

  const config = await loadConfig();
  const { cognito } = config;
  if (!cognito.domain || !cognito.clientId || !cognito.redirectUri) {
    throw createHttpError(500, "Cognito configuration missing for auth callback");
  }

  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", cognito.clientId);
  params.set("redirect_uri", cognito.redirectUri);
  params.set("code", code);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cognito.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${cognito.clientId}:${cognito.clientSecret}`).toString("base64")}`;
  }

  const tokenUrl = `${cognito.domain}/oauth2/token`;
  console.info("[/auth/callback] exchanging code", { tokenUrl, redirectUri: cognito.redirectUri });
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  const text = await resp.text();
  let tokenData = {};
  if (text) {
    try {
      tokenData = JSON.parse(text);
    } catch (error) {
      console.warn("[/auth/callback] failed to parse token response", { message: error.message });
    }
  }

  if (!resp.ok) {
    console.error("[lambda] Cognito token exchange failed on callback", {
      status: resp.status,
      body: tokenData,
    });
    const description = tokenData?.error_description || tokenData?.error || "Token exchange failed";
    throw createHttpError(resp.status, description);
  }

  const cookies = [];
  const maxAge = Number.parseInt(tokenData.expires_in, 10) || 3600;
  const cookieAttributes = "Path=/; SameSite=Lax; Secure";
  if (tokenData.access_token) {
    cookies.push(`sp_at=${tokenData.access_token}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
    cookies.push(`sp_token=${tokenData.access_token}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
  }
  if (tokenData.id_token) {
    cookies.push(`sp_it=${tokenData.id_token}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
  }
  if (tokenData.refresh_token) {
    cookies.push(`sp_rt=${tokenData.refresh_token}; ${cookieAttributes}; HttpOnly; Max-Age=${30 * 24 * 60 * 60}`);
  }

  const state = typeof query.state === "string" && query.state.startsWith("/") ? query.state : "/dashboard";
  if (wantsJson) {
    return respond(
      event,
      200,
      {
        accessToken: tokenData.access_token ?? null,
        idToken: tokenData.id_token ?? null,
        refreshToken: tokenData.refresh_token ?? null,
        expiresIn: tokenData.expires_in ?? 3600,
        tokenType: tokenData.token_type ?? "Bearer",
      },
      {
        headers: {
          "cache-control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
  return respond(event, 302, null, {
    headers: {
      Location: state,
    },
    cookies,
  });
}

async function handleChat(event) {
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const payload = await authenticate(event);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();

  if (method === "GET") {
    if (!ENABLE_STUBS) {
      throw createHttpError(501, "Chat service is not configured");
    }
    const conversationId = event.queryStringParameters?.conversationId || crypto.randomUUID();
    const stub = buildStubChatResponse(conversationId);
    stub.traceId = traceId;
    return respond(event, 200, stub, { headers: { "x-safepocket-origin": "stub" } });
  }

  if (method === "POST") {
    if (!ENABLE_STUBS) {
      throw createHttpError(501, "Chat service is not configured");
    }
    let body = {};
    try {
      body = parseJsonBody(event);
    } catch (error) {
      throw createHttpError(400, "Invalid JSON body");
    }
    const conversationId = body.conversationId || crypto.randomUUID();
    const userMessage = typeof body.message === "string" ? body.message : undefined;
    const stub = buildStubChatResponse(conversationId, userMessage);
    stub.traceId = traceId;
    return respond(event, 200, stub, { headers: { "x-safepocket-origin": "stub" } });
  }

  return respond(event, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported chat method" } });
}

async function handleTransactionsSync(event) {
  await authenticate(event);
  const authorization = extractAuthorizationHeader(event);
  if (!authorization) {
    return respond(event, 401, { error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
  }
  let body = {};
  try {
    body = parseJsonBody(event);
  } catch {
    body = {};
  }
  try {
    const { status, payload } = await fetchLedgerJson("/transactions/sync", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });
    return respond(event, status, payload);
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "TRANSACTIONS_SYNC_FAILED",
        message: error?.message || "Failed to trigger transaction sync",
        details: error?.payload,
      },
    });
  }
}

async function handleTransactionsReset(event) {
  await authenticate(event);
  return respond(event, 202, {
    status: "ACCEPTED",
    traceId: event.requestContext?.requestId || crypto.randomUUID(),
  });
}

exports.handler = async (event) => {
  try {
    const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: RESPONSE_HEADERS, body: "" };
    }

    const stage = event.requestContext?.stage ? `/${event.requestContext.stage}` : "";
    let rawPath = event.rawPath || event.path || "/";
    if (stage && rawPath.startsWith(stage)) {
      rawPath = rawPath.slice(stage.length) || "/";
    }
    const path = rawPath.replace(/\/+/g, "/");
    const query = event.queryStringParameters || {};

    if (method === "GET" && (path === "/" || path === "")) {
      return respond(event, 200, { status: "ok" });
    }
    if (method === "GET" && path === "/health") {
      return respond(event, 200, { status: "ok" });
    }
    if (method === "POST" && path === "/auth/token") {
      return await handleAuthToken(event);
    }
    if (method === "GET" && path === "/auth/callback") {
      return await handleAuthCallback(event);
    }
    if (path === "/chat" || path === "/api/chat" || path === "/ai/chat") {
      if (method === "GET" || method === "POST") {
        return await handleChat(event);
      }
      return respond(event, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported chat method" } });
    }
    if (method === "GET" && path === "/analytics/summary") {
      return await handleAnalyticsSummary(event, query);
    }
    if (method === "GET" && path === "/transactions") {
      return await handleTransactions(event, query);
    }
    if (method === "POST" && path === "/transactions/sync") {
      return await handleTransactionsSync(event);
    }
    if (method === "POST" && path === "/transactions/reset") {
      return await handleTransactionsReset(event);
    }
    if (method === "GET" && path === "/accounts") {
      return await handleAccounts(event);
    }
    if (method === "POST" && path === "/plaid/link-token") {
      return await handlePlaidLinkToken(event);
    }
    if (method === "POST" && path === "/plaid/exchange") {
      return await handlePlaidExchange(event);
    }
    if (method === "GET" && path === "/diagnostics/dns") {
      return await handleDnsDiagnostics(event);
    }

    return respond(event, 404, { error: "Not Found" });
  } catch (error) {
    console.error("[lambda] handler error", error);
    const timeoutTriggered = error && error.code === "DB_OPERATION_TIMEOUT";
    const status = timeoutTriggered ? 504 : error.statusCode || error.status || 500;
    return respond(event, status, {
      error: {
        code: timeoutTriggered
          ? "DB_TIMEOUT"
          : error instanceof SchemaNotMigratedError
            ? "DB_SCHEMA_NOT_READY"
            : "LAMBDA_ERROR",
        message: error.message || "Internal Server Error",
      },
    });
  }
};
