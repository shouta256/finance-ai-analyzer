"use strict";

const crypto = require("crypto");
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
const secretsManager = new AWS.SecretsManager();

const SECRET_COGNITO = process.env.SECRET_COGNITO_NAME || "/safepocket/cognito";
const SECRET_DB = process.env.SECRET_DB_NAME || "/safepocket/db";
const SECRET_PLAID = process.env.SECRET_PLAID_NAME || "/safepocket/plaid";

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-request-trace",
  "Access-Control-Allow-Credentials": "true",
};

let configPromise;
let pgPool = null;
const jwksCache = new Map();

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
    const [cognitoSecret, dbSecret, plaidSecret] = await Promise.all([
      fetchSecret(SECRET_COGNITO),
      fetchSecret(SECRET_DB),
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
    const cognitoIssuer = process.env.COGNITO_ISSUER || cognitoSecret?.issuer;
    const cognitoAudience =
      process.env.COGNITO_AUDIENCE || cognitoSecret?.audience || cognitoClientId || cognitoSecret?.clientId;
    const cognitoJwksUrl =
      process.env.COGNITO_JWKS_URL ||
      cognitoSecret?.jwksUrl ||
      (cognitoDomain ? `${stripTrailingSlash(ensureHttps(cognitoDomain))}/.well-known/jwks.json` : undefined);

    const dbConfig = {
      connectionString: process.env.DATABASE_URL || dbSecret?.connectionString,
      host: process.env.DB_HOST || dbSecret?.host,
      port: parseInt(process.env.DB_PORT || dbSecret?.port || "5432", 10),
      user: process.env.DB_USER || dbSecret?.username || dbSecret?.user,
      password: process.env.DB_PASSWORD || dbSecret?.password,
      database: process.env.DB_NAME || dbSecret?.dbname || dbSecret?.database,
      ssl: process.env.DB_SSL ?? dbSecret?.ssl,
    };

    const plaidConfig = {
      clientId: process.env.PLAID_CLIENT_ID || plaidSecret?.clientId || plaidSecret?.client_id,
      clientSecret: process.env.PLAID_CLIENT_SECRET || plaidSecret?.clientSecret || plaidSecret?.client_secret,
      env: process.env.PLAID_ENV || plaidSecret?.env || plaidSecret?.environment || "sandbox",
    };

    return {
      cognito: {
        domain: stripTrailingSlash(ensureHttps(cognitoDomain)),
        clientId: cognitoClientId,
        clientSecret: cognitoClientSecret,
        redirectUri: cognitoRedirectUri,
        issuer: cognitoIssuer,
        audienceList: (cognitoAudience || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        jwksUrl: cognitoJwksUrl,
      },
      db: dbConfig,
      plaid: plaidConfig,
    };
  })();
  return configPromise;
}

async function ensurePgPool() {
  if (pgPool) return pgPool;
  const { db } = await loadConfig();
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (error) {
    throw new Error("pg モジュールを Layer で提供するか ZIP に同梱してください");
  }

  if (db.connectionString) {
    pgPool = new Pool({
      connectionString: db.connectionString,
      ssl:
        db.ssl === "false" || db.ssl === false
          ? undefined
          : {
              rejectUnauthorized: false,
            },
    });
    return pgPool;
  }

  if (!db.host) {
    throw new Error("DATABASE_URL もしくは DB_HOST/DB_USER/DB_PASSWORD/DB_NAME を設定してください");
  }

  pgPool = new Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl:
      db.ssl === "false" || db.ssl === false
        ? undefined
        : {
            rejectUnauthorized: false,
          },
  });
  return pgPool;
}

async function getJwks(jwksUrl) {
  if (!jwksUrl) throw new Error("JWKS URL not configured");
  const cached = jwksCache.get(jwksUrl);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
    return cached.value;
  }
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
  const json = await res.json();
  jwksCache.set(jwksUrl, { value: json, fetchedAt: now });
  return json;
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
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw createHttpError(401, "Malformed JWT");
  }

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  const jwks = await getJwks(cognito.jwksUrl);
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) throw createHttpError(401, "Unable to find matching JWKS key");

  const publicKey = crypto.createPublicKey({ key, format: "jwk" });
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signature = Buffer.from(signatureB64, "base64url");
  if (!verifier.verify(publicKey, signature)) {
    throw createHttpError(401, "Invalid signature");
  }

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (cognito.issuer && payload.iss !== cognito.issuer) {
    throw createHttpError(401, "Issuer mismatch");
  }
  if (cognito.audienceList.length > 0) {
    let ok = false;
    if (Array.isArray(payload.aud)) {
      ok = payload.aud.some((aud) => cognito.audienceList.includes(aud));
    } else if (typeof payload.aud === "string") {
      ok = cognito.audienceList.includes(payload.aud);
    }
    const clientId = payload.client_id;
    if (!ok && !(clientId && payload.token_use === "access" && cognito.audienceList.includes(clientId))) {
      throw createHttpError(401, "Audience/client_id mismatch");
    }
  }
  if (!payload.sub) {
    throw createHttpError(401, "Token missing subject");
  }
  return payload;
}

function parseJsonBody(event) {
  if (!event.body) return {};
  if (event.isBase64Encoded) {
    return JSON.parse(Buffer.from(event.body, "base64").toString("utf8"));
  }
  return JSON.parse(event.body);
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
  const pool = await ensurePgPool();
  const res = await pool.query(
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
     WHERE t.user_id = $1
       AND t.occurred_at >= $2
       AND t.occurred_at < $3
     ORDER BY t.occurred_at DESC`,
    [userId, fromDate.toISOString(), toDate.toISOString()]
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
      summary: "AI ハイライトはまだ有効化されていません。",
      sentiment: "NEUTRAL",
      recommendations: ["口座同期を確認してください", "必要に応じてカテゴリーを整理してください"],
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
  const transactions = await queryTransactions(payload.sub, fromDate, toDate);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  return buildResponse(200, summarise(transactions, fromDate, toDate, monthLabel, traceId));
}

async function handleTransactions(event, query) {
  const payload = await authenticate(event);
  const { fromDate, toDate, monthLabel } = parseRange(query);
  const transactions = await queryTransactions(payload.sub, fromDate, toDate);
  const page = Math.max(parseInt(query.page || "0", 10), 0);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize || "15", 10), 1), 100);
  const start = page * pageSize;
  const paged = transactions.slice(start, start + pageSize);
  return buildResponse(200, {
    transactions: paged,
    period: {
      month: monthLabel,
      from: monthLabel ? null : toIsoDate(fromDate),
      to: monthLabel ? null : toIsoDate(new Date(toDate.getTime() - 1)),
    },
    aggregates: buildTransactionsAggregates(transactions),
    traceId: event.requestContext?.requestId || crypto.randomUUID(),
  });
}

async function handleAccounts(event) {
  const payload = await authenticate(event);
  const pool = await ensurePgPool();
  const res = await pool.query(
    `SELECT id, name, institution, created_at AT TIME ZONE 'UTC' AS created_at
     FROM accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [payload.sub]
  );
  const accounts = await Promise.all(
    res.rows.map(async (row) => {
      const balanceRes = await pool.query(
        `SELECT COALESCE(SUM(amount::numeric),0) AS balance FROM transactions WHERE account_id = $1`,
        [row.id]
      );
      const balance = balanceRes.rows[0] ? Number(balanceRes.rows[0].balance) : 0;
      return {
        id: row.id,
        name: row.name,
        institution: row.institution,
        balance: round(balance),
        currency: "USD",
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      };
    })
  );
  return buildResponse(200, { accounts, traceId: event.requestContext?.requestId || crypto.randomUUID() });
}

async function handleAuthToken(event) {
  const body = parseJsonBody(event);
  const grantType = body.grantType || body.grant_type;
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

  const resp = await fetch(`${cognito.domain}/oauth2/token`, {
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
  return buildResponse(200, {
    accessToken: json.access_token,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    tokenType: json.token_type,
    scope: json.scope,
  });
}

async function handleTransactionsSync(event) {
  await authenticate(event);
  return buildResponse(202, {
    status: "STARTED",
    syncedCount: 0,
    pendingCount: 0,
    traceId: event.requestContext?.requestId || crypto.randomUUID(),
  });
}

async function handleTransactionsReset(event) {
  await authenticate(event);
  return buildResponse(202, {
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
      return buildResponse(200, { status: "ok" });
    }
    if (method === "GET" && path === "/health") {
      return buildResponse(200, { status: "ok" });
    }
    if (method === "POST" && path === "/auth/token") {
      return await handleAuthToken(event);
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

    return buildResponse(404, { error: "Not Found" });
  } catch (error) {
    console.error("[lambda] handler error", error);
    const status = error.statusCode || error.status || 500;
    return buildResponse(status, {
      error: { code: "LAMBDA_ERROR", message: error.message || "Internal Server Error" },
    });
  }
};
