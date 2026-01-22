"use strict";

require("./src/bootstrap/fetch-debug");

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
const dns = require("dns").promises;
const secretsManager = new AWS.SecretsManager();
const kms = new AWS.KMS();
const { withUserClient } = require("./src/db/pool");
const { SchemaNotMigratedError } = require("./src/bootstrap/schemaGuard");

function resolveSecretName(value, fallback) {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

const SECRET_COGNITO = resolveSecretName(process.env.SECRET_COGNITO_NAME, "/safepocket/cognito");
const SECRET_PLAID = resolveSecretName(process.env.SECRET_PLAID_NAME, "/safepocket/plaid");
const PLAID_TIMEOUT_MS = Number(process.env.PLAID_TIMEOUT_MS || "8000");
const LEDGER_TIMEOUT_MS = Number(process.env.LEDGER_PROXY_TIMEOUT_MS || "8000");
const ANON_USER_ID = process.env.ANON_USER_ID || "00000000-0000-0000-0000-000000000000";
const ADMIN_SQL_TOKEN = process.env.ADMIN_SQL_TOKEN || "";

// Demo login configuration
const DEV_JWT_SECRET = process.env.SAFEPOCKET_DEV_JWT_SECRET || "dev-secret-key-for-local-development-only";
const DEV_USER_ID = process.env.DEV_USER_ID || "0f08d2b9-28b3-4b28-bd33-41a36161e9ab";
const DEV_LOGIN_ENABLED = ["true", "1", "yes"].includes(
  String(process.env.ENABLE_DEV_LOGIN || process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN || "true").toLowerCase()
);

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
const NORMALISED_ALLOWED_ORIGINS = ALLOWED_ORIGINS.map((origin) => normaliseOriginUrl(origin)).filter(Boolean);
const CHAT_SYSTEM_PROMPT =
  "You are Safepocket's financial helper. Use the provided context to answer. Context JSON includes 'summary' (month totals, top categories/merchants) and 'recentTransactions' (latest activity). Provide amounts in US dollars with sign-aware formatting, cite exact dates, and do not invent data beyond the supplied context.";
const CHAT_MAX_HISTORY_MESSAGES = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_HISTORY_LIMIT || "3", 10), 0);
const CHAT_HISTORY_CHAR_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_HISTORY_CHAR_LIMIT || "1200", 10), 200);
const CHAT_CONTEXT_CHAR_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_CHAT_CONTEXT_LIMIT || "8000", 10), 2000);
const CHAT_DEFAULT_MAX_TOKENS = Math.max(Number.parseInt(process.env.SAFEPOCKET_AI_MAX_TOKENS || "1200", 10), 200);
let chatTablesEnsured = false;

const HIGHLIGHT_SYSTEM_PROMPT =
  "You are Safepocket's monthly finance analyst. Review the provided spending data and craft a short highlight. Respond with compact JSON that matches {\"title\": string, \"summary\": string, \"sentiment\": \"POSITIVE\"|\"NEUTRAL\"|\"NEGATIVE\", \"recommendations\": string[]}. Mention net cash flow, notable categories or merchants, and give 2-4 actionable, empathetic tips.";
const HIGHLIGHT_MAX_TOKENS = Math.max(Number.parseInt(process.env.SAFEPOCKET_HIGHLIGHT_MAX_TOKENS || "700", 10), 200);
const HIGHLIGHT_TRANSACTIONS_LIMIT = Math.max(Number.parseInt(process.env.SAFEPOCKET_HIGHLIGHT_TX_LIMIT || "20", 10), 5);
const HIGHLIGHT_TOP_CATEGORY_LIMIT = 5;
const HIGHLIGHT_TOP_MERCHANT_LIMIT = 5;

let configPromise;
let configCacheKey;
const cognitoJwkCache = new Map();
let userTableSupportsFullName = null;
let plaidTokenColumnName = null;
const cognitoJweKeyCache = new Map();

let joseRuntimePromise;
function loadJoseRuntime() {
  if (!joseRuntimePromise) {
    joseRuntimePromise = import("jose").then((mod) => ({
      importPKCS8: mod.importPKCS8,
      compactDecrypt: mod.compactDecrypt,
      createRemoteJWKSet: mod.createRemoteJWKSet,
      jwtVerify: mod.jwtVerify,
      SignJWT: mod.SignJWT,
      errors: mod.errors,
    }));
  }
  return joseRuntimePromise;
}

function stripTrailingSlash(value) {
  if (!value) return value;
  return value.replace(/\/+$/g, "");
}

function ensureHttps(value) {
  if (!value) return value;
  return value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
}

function parseSymmetricKey(raw) {
  if (!raw) return null;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44) {
      const decoded = Buffer.from(raw, "base64");
      if (decoded.length === 32) return decoded;
    }
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
      return Buffer.from(raw, "hex");
    }
  } catch {
    return null;
  }
  return null;
}

const DATA_KEY_RAW = process.env.SAFEPOCKET_KMS_DATA_KEY || "";
const KMS_KEY_ID = process.env.SAFEPOCKET_KMS_KEY_ID || "";
const SYM_KEY = parseSymmetricKey(DATA_KEY_RAW);

async function encryptSecret(plain) {
  if (SYM_KEY) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", SYM_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `v1:gcm:${iv.toString("base64")}:${encrypted.toString("base64")}:${authTag.toString("base64")}`;
  }
  if (KMS_KEY_ID) {
    const out = await kms
      .encrypt({
        KeyId: KMS_KEY_ID,
        Plaintext: Buffer.from(String(plain), "utf8"),
      })
      .promise();
    return `v1:kms:${out.CiphertextBlob.toString("base64")}`;
  }
  throw createHttpError(500, "Encryption key is not configured (set SAFEPOCKET_KMS_DATA_KEY or SAFEPOCKET_KMS_KEY_ID)");
}

async function decryptSecret(blob) {
  if (!blob || typeof blob !== "string") return null;
  const parts = blob.split(":");
  if (parts[0] !== "v1") return null;
  if (parts[1] === "gcm" && SYM_KEY) {
    const iv = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const tag = Buffer.from(parts[4], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SYM_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  }
  if (parts[1] === "kms" && KMS_KEY_ID) {
    const decrypted = await kms
      .decrypt({ CiphertextBlob: Buffer.from(parts[2], "base64") })
      .promise();
    return decrypted.Plaintext.toString("utf8");
  }
  throw createHttpError(500, "Unable to decrypt secret with current configuration");
}

function hashToUuid(value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest();
  const bytes = Buffer.from(hash.slice(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function withSavepoint(client, label, fn) {
  const name = `sp_${label}_${crypto.randomUUID().replace(/-/g, "")}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client
      .query(`ROLLBACK TO SAVEPOINT ${name}`)
      .catch((rollbackError) => console.warn("[lambda] failed to rollback savepoint", { label, message: rollbackError?.message }));
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    throw error;
  }
}

function resolveUserProfile(authPayload) {
  const fallbackEmail = authPayload?.sub ? `${authPayload.sub}@users.safepocket.local` : "user@safepocket.local";
  const email =
    typeof authPayload?.email === "string" && authPayload.email.includes("@") ? authPayload.email : fallbackEmail;
  const rawName =
    typeof authPayload?.name === "string" && authPayload.name.trim().length > 0
      ? authPayload.name
      : typeof authPayload?.preferred_username === "string" && authPayload.preferred_username.trim().length > 0
        ? authPayload.preferred_username
        : typeof authPayload?.["cognito:username"] === "string" && authPayload["cognito:username"].trim().length > 0
          ? authPayload["cognito:username"]
          : email;
  const fullName = rawName.trim();
  return { email, fullName };
}

function cacheKeyForJwe(alg, pem) {
  return `${alg}::${pem}`;
}

async function getCognitoJweKey(cognito, alg) {
  if (!cognito?.jwePrivateKey) return null;
  const key = cacheKeyForJwe(alg, cognito.jwePrivateKey);
  let entry = cognitoJweKeyCache.get(key);
  if (!entry) {
    const { importPKCS8 } = await loadJoseRuntime();
    entry = await importPKCS8(cognito.jwePrivateKey, alg || "RSA-OAEP");
    cognitoJweKeyCache.set(key, entry);
  }
  return entry;
}

async function maybeDecryptJwt(token, cognito) {
  if (!token || typeof token !== "string") return token;
  const parts = token.split(".");
  if (parts.length !== 5) {
    return token; // already a standard JWT
  }
  if (!cognito?.jwePrivateKey) {
    throw createHttpError(401, "Encrypted token received but no Cognito JWE private key configured");
  }
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch (error) {
    throw createHttpError(401, "Invalid encrypted token header");
  }
  const alg = typeof header?.alg === "string" && header.alg.trim().length > 0 ? header.alg : "RSA-OAEP";
  try {
    const cryptoKey = await getCognitoJweKey(cognito, alg);
    if (!cryptoKey) {
      throw createHttpError(401, "JWE private key unavailable");
    }
    const { compactDecrypt } = await loadJoseRuntime();
    const { plaintext } = await compactDecrypt(token, cryptoKey);
    return Buffer.from(plaintext).toString("utf8");
  } catch (error) {
    console.error("[auth] failed to decrypt Cognito token", { message: error?.message });
    throw createHttpError(401, "Failed to decrypt Cognito token");
  }
}

async function usersTableHasFullName(client) {
  if (userTableSupportsFullName !== null) {
    return userTableSupportsFullName;
  }
  try {
    const res = await client.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'users'
         AND column_name = 'full_name'
       LIMIT 1`,
    );
    userTableSupportsFullName = res.rowCount > 0;
  } catch (error) {
    console.warn("[lambda] failed to inspect users table columns", { message: error?.message });
    userTableSupportsFullName = false;
  }
  return userTableSupportsFullName;
}

async function ensureUserRow(client, authPayload) {
  if (!authPayload?.sub) return;
  const { email, fullName } = resolveUserProfile(authPayload);
  const hasFullNameColumn = await usersTableHasFullName(client);
  if (hasFullNameColumn) {
    try {
      await client.query(
        `INSERT INTO users (id, email, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id)
         DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
        [authPayload.sub, email, fullName],
      );
      userTableSupportsFullName = true;
      return;
    } catch (error) {
      if (error?.code !== "42703" && !(typeof error?.message === "string" && error.message.includes("full_name"))) {
        throw error;
      }
      userTableSupportsFullName = false;
    }
  }

  await client.query(
    `INSERT INTO users (id, email)
     VALUES ($1, $2)
     ON CONFLICT (id)
     DO UPDATE SET email = EXCLUDED.email`,
    [authPayload.sub, email],
  );
}

async function resolvePlaidTokenColumn(client) {
  if (plaidTokenColumnName) return plaidTokenColumnName;
  const candidates = ["encrypted_access_token", "access_token_enc", "access_token"];
  try {
    const res = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'plaid_items'
         AND column_name = ANY($1::text[])`,
      [candidates],
    );
    const found = res.rows.map((row) => row.column_name).find((name) => candidates.includes(name));
    if (found) {
      plaidTokenColumnName = found;
      return plaidTokenColumnName;
    }
  } catch (error) {
    console.warn("[lambda] failed to inspect plaid_items columns", { message: error?.message });
  }
  plaidTokenColumnName = "encrypted_access_token";
  return plaidTokenColumnName;
}

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

function pickPreferredRedirectOrigin() {
  const nonExecuteApi = NORMALISED_ALLOWED_ORIGINS.find((origin) => !/execute-api/i.test(origin));
  return nonExecuteApi || NORMALISED_ALLOWED_ORIGINS[0];
}

function resolvePostAuthRedirect(state) {
  const defaultOrigin = pickPreferredRedirectOrigin();
  const defaultPath = "/dashboard";
  if (state) {
    try {
      const url = new URL(state);
      const normalised = normaliseOriginUrl(url.origin);
      if (normalised && NORMALISED_ALLOWED_ORIGINS.includes(normalised)) {
        url.hash = "";
        return url.toString();
      }
    } catch {
      if (state.startsWith("/")) {
        if (defaultOrigin) {
          const target = new URL(defaultOrigin);
          target.pathname = state;
          target.search = "";
          target.hash = "";
          return target.toString();
        }
        return state;
      }
    }
  }
  if (defaultOrigin) {
    const target = new URL(defaultOrigin);
    target.pathname = defaultPath;
    target.search = "";
    target.hash = "";
    return target.toString();
  }
  return defaultPath;
}

function isAuthOptional() {
  const v = String(
    process.env.AUTH_OPTIONAL ||
    process.env.NEXT_PUBLIC_AUTH_OPTIONAL ||
    ""
  ).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
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
  const cacheKey = [
    process.env.CONFIG_BUMP || "",
    process.env.SECRET_COGNITO_NAME || "",
    process.env.SECRET_PLAID_NAME || "",
  ].join("|");
  if (configPromise && configCacheKey === cacheKey) return configPromise;
  configCacheKey = cacheKey;
  configPromise = (async () => {
    const [cognitoSecret, plaidSecret] = await Promise.all([
      fetchSecret(SECRET_COGNITO),
      fetchSecret(SECRET_PLAID),
    ]);

    const normalize = (value) => (typeof value === "string" ? value.trim() : undefined);

    const cognitoDomain =
      normalize(process.env.COGNITO_DOMAIN) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_DOMAIN) ||
      normalize(cognitoSecret?.domain);
    const cognitoClientIdWeb =
      normalize(process.env.COGNITO_CLIENT_ID_WEB) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID_WEB) ||
      normalize(cognitoSecret?.clientIdWeb) ||
      normalize(cognitoSecret?.client_id_web);
    const cognitoClientIdNative =
      normalize(process.env.COGNITO_CLIENT_ID_NATIVE) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID_NATIVE) ||
      normalize(cognitoSecret?.clientIdNative) ||
      normalize(cognitoSecret?.client_id_native);
    const cognitoClientIdExplicit =
      normalize(process.env.COGNITO_CLIENT_ID) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID) ||
      normalize(cognitoSecret?.clientId) ||
      normalize(cognitoSecret?.client_id);
    const cognitoClientId = cognitoClientIdExplicit || cognitoClientIdWeb || cognitoClientIdNative;
    const cognitoClientSecret =
      normalize(process.env.COGNITO_CLIENT_SECRET) ||
      normalize(cognitoSecret?.clientSecret) ||
      normalize(cognitoSecret?.client_secret);
    const cognitoRedirectUri =
      normalize(process.env.COGNITO_REDIRECT_URI) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI) ||
      normalize(cognitoSecret?.redirectUri) ||
      normalize(cognitoSecret?.redirect_uri);
    const cognitoRedirectUriNative =
      normalize(process.env.COGNITO_REDIRECT_URI_NATIVE) ||
      normalize(process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI_NATIVE) ||
      normalize(cognitoSecret?.redirectUriNative) ||
      normalize(cognitoSecret?.redirect_uri_native);
    const cognitoRegion =
      process.env.COGNITO_REGION || cognitoSecret?.region || cognitoSecret?.regionId || cognitoSecret?.region_id;
    let cognitoIssuer = process.env.COGNITO_ISSUER || cognitoSecret?.issuer;
    const cognitoAudience =
      normalize(process.env.COGNITO_AUDIENCE) ||
      normalize(cognitoSecret?.audience) ||
      cognitoClientId ||
      normalize(cognitoSecret?.clientId);
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
    let normalisedIssuer = cognitoIssuer ? stripTrailingSlash(ensureHttps(cognitoIssuer)) : undefined;
    const normalisedDomain = cognitoDomain ? stripTrailingSlash(ensureHttps(cognitoDomain)) : undefined;
    let cognitoJwksUrl =
      process.env.COGNITO_JWKS_URL ||
      cognitoSecret?.jwksUrl ||
      (normalisedIssuer ? `${normalisedIssuer}/.well-known/jwks.json` : undefined) ||
      (normalisedDomain ? `${normalisedDomain}/.well-known/jwks.json` : undefined);

    if ((!cognitoJwksUrl || !normalisedIssuer) && normalisedDomain) {
      try {
        const wellKnownRes = await fetch(`${normalisedDomain}/.well-known/openid-configuration`, { method: "GET" });
        if (wellKnownRes.ok) {
          const wellKnown = await wellKnownRes.json().catch(() => null);
          if (!cognitoJwksUrl && wellKnown?.jwks_uri) {
            cognitoJwksUrl = wellKnown.jwks_uri;
          }
          if (!normalisedIssuer && typeof wellKnown?.issuer === "string") {
            normalisedIssuer = stripTrailingSlash(ensureHttps(wellKnown.issuer));
          }
        }
      } catch (error) {
        console.warn("[lambda] failed to load Cognito OpenID configuration", { message: error?.message });
      }
    }
    const cognitoJwePrivateKey =
      process.env.COGNITO_JWE_PRIVATE_KEY ||
      cognitoSecret?.encryptionPrivateKey ||
      cognitoSecret?.tokenDecryptionKey ||
      cognitoSecret?.privateKey ||
      undefined;

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
        domain: normalisedDomain,
        clientId: cognitoClientId,
        clientIdWeb: cognitoClientIdWeb,
        clientIdNative: cognitoClientIdNative,
        clientSecret: cognitoClientSecret,
        redirectUri: cognitoRedirectUri,
        redirectUriNative: cognitoRedirectUriNative,
        issuer: normalisedIssuer,
        userPoolId: cognitoUserPoolId,
        region: derivedRegion,
        audienceList: (cognitoAudience || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        jwksUrl: cognitoJwksUrl,
        jwePrivateKey: typeof cognitoJwePrivateKey === "string" && cognitoJwePrivateKey.trim().length > 0 ? cognitoJwePrivateKey.trim() : undefined,
      },
      plaid: plaidConfig,
    };
  })();
  return configPromise;
}

function normalizeAudienceList(ids) {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0),
    ),
  );
}

function resolveExpectedAudiences(cognito) {
  const collected = new Set(normalizeAudienceList(cognito?.audienceList));
  if (cognito?.clientId) {
    collected.add(cognito.clientId);
  }
  if (cognito?.clientIdWeb) {
    collected.add(cognito.clientIdWeb);
  }
  if (cognito?.clientIdNative) {
    collected.add(cognito.clientIdNative);
  }
  return Array.from(collected).filter(Boolean);
}

async function getCognitoRemoteJwkSet(cognito) {
  if (!cognito?.jwksUrl) {
    throw createHttpError(500, "Cognito JWKS URL not configured");
  }
  const cacheKey = cognito.jwksUrl;
  let jwkSet = cognitoJwkCache.get(cacheKey);
  if (!jwkSet) {
    const { createRemoteJWKSet } = await loadJoseRuntime();
    jwkSet = createRemoteJWKSet(new URL(cognito.jwksUrl), { timeoutDuration: 5000 });
    cognitoJwkCache.set(cacheKey, jwkSet);
  }
  return jwkSet;
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

  if (!token || token === "undefined" || token === "null" || token === "") {
    if (isAuthOptional()) {
      return { sub: ANON_USER_ID, token_use: "anonymous" };
    }
    throw createHttpError(401, "Unauthorized");
  }
  return verifyJwt(token);
}

async function verifyJwt(token) {
  const { cognito } = await loadConfig();
  token = await maybeDecryptJwt(token, cognito);
  if (typeof token !== "string") {
    throw createHttpError(401, "Unauthorized");
  }
  const trimmedToken = token.trim();
  const parts = trimmedToken.split(".");
  if (parts.length !== 3) {
    console.warn("[auth] non-JWT token received", { preview: trimmedToken.slice(0, 12) });
    throw createHttpError(401, "Unauthorized");
  }
  const { jwtVerify, errors: joseErrors } = await loadJoseRuntime();

  // Try HS256 demo token verification first if dev login is enabled
  if (DEV_LOGIN_ENABLED && DEV_JWT_SECRET && DEV_JWT_SECRET.length >= 32) {
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (header.alg === "HS256") {
        const secretKey = new TextEncoder().encode(DEV_JWT_SECRET);
        const { payload } = await jwtVerify(trimmedToken, secretKey, { algorithms: ["HS256"] });
        if (payload && typeof payload === "object" && payload.sub) {
          // Accept demo tokens with issuer "safepocket-dev"
          if (payload.iss === "safepocket-dev") {
            return payload;
          }
        }
      }
    } catch (e) {
      // HS256 verification failed, fall through to Cognito RS256
      console.debug("[auth] HS256 demo token verification failed, trying Cognito RS256", { error: e?.message });
    }
  }

  const jwkSet = await getCognitoRemoteJwkSet(cognito);
  const audiences = resolveExpectedAudiences(cognito);
  const baseOptions = {};
  if (cognito.issuer) {
    baseOptions.issuer = cognito.issuer;
  }
  baseOptions.algorithms = ["RS256"];
  const optionVariants =
    audiences.length > 0
      ? [{ ...baseOptions, audience: audiences }, baseOptions]
      : [baseOptions];
  let lastError;
  for (const options of optionVariants) {
    try {
      const { payload } = await jwtVerify(trimmedToken, jwkSet, options);
      if (!payload || typeof payload !== "object") {
        throw createHttpError(401, "Token payload invalid");
      }
      if (!payload.sub) {
        throw createHttpError(401, "Token missing subject");
      }
      if (cognito.issuer && payload.iss !== cognito.issuer) {
        throw createHttpError(401, "Issuer mismatch");
      }
      const tokenUse =
        typeof payload.token_use === "string" && payload.token_use.trim().length > 0
          ? payload.token_use.trim()
          : null;
      if (tokenUse && tokenUse !== "access" && tokenUse !== "id") {
        console.warn("[auth] unexpected token_use", { tokenUse });
      }
      if (audiences.length > 0) {
        const listedAudiences = Array.isArray(payload.aud)
          ? payload.aud.map((value) => String(value))
          : typeof payload.aud === "string"
            ? [payload.aud]
            : [];
        const clientIdFallback =
          typeof payload.client_id === "string" && payload.client_id.trim().length > 0
            ? payload.client_id.trim()
            : typeof payload.clientId === "string" && payload.clientId.trim().length > 0
              ? payload.clientId.trim()
              : null;
        const matchesAud = listedAudiences.some((aud) => audiences.includes(aud));
        const matchesClient = clientIdFallback ? audiences.includes(clientIdFallback) : false;
        if (!matchesAud && !matchesClient) {
          throw createHttpError(401, "Audience mismatch");
        }
      }
      return payload;
    } catch (error) {
      console.warn("[auth] jwt verification failed", {
        audience: options.audience,
        issuer: options.issuer,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      });
      if (error instanceof joseErrors.JWTExpired) {
        throw createHttpError(401, "Token expired");
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed && error.claim === "aud") {
        lastError = error;
        continue;
      }
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
  if (lastError instanceof joseErrors.JWSSignatureVerificationFailed) {
    throw createHttpError(401, "Token signature invalid");
  }
  const fallbackOptions = { algorithms: ["RS256"] };
  try {
    const { payload } = await jwtVerify(trimmedToken, jwkSet, fallbackOptions);
    if (!payload?.sub) throw createHttpError(401, "Token missing subject");
    if (cognito.issuer && payload.iss && payload.iss !== cognito.issuer) {
      throw createHttpError(401, "Issuer mismatch");
    }
    const listedAudiences = Array.isArray(payload?.aud)
      ? payload.aud.map((value) => String(value))
      : typeof payload?.aud === "string"
        ? [payload.aud]
        : [];
    const clientIdFallback =
      payload && typeof payload === "object" && typeof payload.client_id === "string" && payload.client_id.trim().length > 0
        ? payload.client_id.trim()
        : payload && typeof payload === "object" && typeof payload.clientId === "string" && payload.clientId.trim().length > 0
          ? payload.clientId.trim()
          : null;
    if (audiences.length > 0) {
      const matchesAud = listedAudiences.some((aud) => audiences.includes(aud));
      const matchesClient = clientIdFallback ? audiences.includes(clientIdFallback) : false;
      if (!matchesAud && !matchesClient) {
        throw createHttpError(401, "Audience mismatch");
      }
    }
    return payload;
  } catch (error) {
    if (error instanceof joseErrors.JWTClaimValidationFailed && error.claim === "iss") {
      throw createHttpError(401, "Issuer mismatch");
    }
    throw createHttpError(401, "Token verification failed");
  }
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
  console.log("[parseRange] Input query:", JSON.stringify({ month: query.month, from: query.from, to: query.to }));
  if (query.from && query.to) {
    const fromDate = parseMonth(query.from);
    const endDate = parseMonth(query.to);
    console.log("[parseRange] Using custom range:", { from: query.from, to: query.to });
    return {
      fromDate,
      toDate: new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 1)),
      monthLabel: null,
    };
  }
  if (query.month) {
    const start = parseMonth(query.month);
    console.log("[parseRange] Using month:", query.month);
    return {
      fromDate: start,
      toDate: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      monthLabel: query.month,
    };
  }
  console.log("[parseRange] Using default range (all history)");
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

function mapTransactionRow(row) {
  return {
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
  };
}

async function queryTransactionsWithClient(client, fromDate, toDate) {
  const res = await client.query(
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
  );
  return res.rows.map(mapTransactionRow);
}

async function queryTransactions(userId, fromDate, toDate) {
  return withUserClient(userId, (client) => queryTransactionsWithClient(client, fromDate, toDate));
}

async function ensureChatTables(client) {
  if (chatTablesEnsured) return;
  try {
    const res = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'chat_messages'
       LIMIT 1`,
    );
    if (res.rowCount === 0) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id uuid PRIMARY KEY,
          conversation_id uuid NOT NULL,
          user_id uuid NOT NULL REFERENCES users(id),
          role text NOT NULL CHECK (role IN ('USER','ASSISTANT')),
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
           ON chat_messages(conversation_id, created_at)`,
      );
    }
    chatTablesEnsured = true;
  } catch (error) {
    console.warn("[chat] failed to ensure chat tables", { message: error?.message });
    throw error;
  }
}

function formatUsd(value, options = {}) {
  const { absolute = false } = options;
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  const amount = absolute ? Math.abs(numeric) : numeric;
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function humaniseLabel(label) {
  if (!label) return "";
  return String(label)
    .replace(/[_\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDeterministicHighlight(totals, categories, merchants) {
  const income = Number(totals?.income ?? 0);
  const rawExpense = Number(totals?.expense ?? 0);
  const expense = Math.abs(rawExpense);
  const net = Number(totals?.net ?? income + rawExpense);

  const summaryParts = [
    `Income ${formatUsd(income, { absolute: true })} vs spend ${formatUsd(expense, { absolute: true })} leads to net ${formatUsd(net)}.`,
  ];

  const topCategory = Array.isArray(categories) && categories.length > 0 ? categories[0] : null;
  if (topCategory?.category) {
    summaryParts.push(
      `Largest category: ${humaniseLabel(topCategory.category)} at ${formatUsd(Math.abs(Number(topCategory.amount ?? 0)), {
        absolute: true,
      })}.`,
    );
  }

  const topMerchant = Array.isArray(merchants) && merchants.length > 0 ? merchants[0] : null;
  const topMerchantAmount = Number(topMerchant?.amount ?? 0);
  if (topMerchant?.merchant) {
    summaryParts.push(
      `Top merchant: ${topMerchant.merchant} with ${formatUsd(Math.abs(topMerchantAmount), {
        absolute: true,
      })} across ${Number(topMerchant.transactionCount ?? 0)} transactions.`,
    );
  }

  let sentiment = "NEUTRAL";
  if (net > 0) {
    sentiment = "POSITIVE";
  } else if (net < -100) {
    sentiment = "NEGATIVE";
  }

  const recommendations = new Set();
  if (net < 0) {
    recommendations.add("Net outflow. Review discretionary spending and adjust upcoming budgets.");
  } else {
    recommendations.add("Net positive month. Allocate part of the surplus to savings or debt repayment.");
  }
  if (topCategory?.category) {
    recommendations.add(`Inspect recent ${humaniseLabel(topCategory.category).toLowerCase()} purchases for savings opportunities.`);
  }
  if (topMerchant?.merchant && topMerchantAmount < 0 && Math.abs(topMerchantAmount) > 200) {
    recommendations.add(`Set a spending alert for ${topMerchant.merchant} next month.`);
  }
  if (recommendations.size < 3) {
    recommendations.add("Schedule a quick budget check-in and update category limits.");
  }

  return {
    title: "Monthly financial health",
    summary: summaryParts.join(" "),
    sentiment,
    recommendations: Array.from(recommendations).slice(0, 4),
  };
}

function buildHighlightPrompt(summary, transactions) {
  const totals = summary?.totals ?? {};
  const anomalies = Array.isArray(summary?.anomalies) ? summary.anomalies : [];
  const categories = Array.isArray(summary?.byCategory) ? summary.byCategory : [];
  const merchants = Array.isArray(summary?.topMerchants) ? summary.topMerchants : [];

  const income = Number(totals.income ?? 0);
  const expense = Math.abs(Number(totals.expense ?? 0));
  const net = Number(totals.net ?? income + Number(totals.expense ?? 0));

  const categoryLines = categories
    .slice(0, HIGHLIGHT_TOP_CATEGORY_LIMIT)
    .map(
      (entry) =>
        `- ${humaniseLabel(entry.category)}: ${formatUsd(Math.abs(Number(entry.amount ?? 0)), { absolute: true })} (${Number(
          entry.percentage ?? 0,
        ).toFixed(2)}%)`,
    )
    .join("\n");

  const merchantLines = merchants
    .slice(0, HIGHLIGHT_TOP_MERCHANT_LIMIT)
    .map(
      (entry) =>
        `- ${entry.merchant}: ${formatUsd(Math.abs(Number(entry.amount ?? 0)), { absolute: true })} (${Number(
          entry.transactionCount ?? 0,
        )} transactions)`,
    )
    .join("\n");

  const anomalyLines = anomalies
    .slice(0, 5)
    .map(
      (entry) =>
        `- ${entry.merchantName || "Unknown"}: amount ${formatUsd(Number(entry.amount ?? 0))}, delta ${formatUsd(
          Number(entry.deltaAmount ?? 0),
        )}, impact ${Number(entry.budgetImpactPercent ?? 0).toFixed(2)}%`,
    )
    .join("\n");

  const transactionLines = transactions
    .slice(0, HIGHLIGHT_TRANSACTIONS_LIMIT)
    .map((tx) => {
      const occurred = tx.occurredAt ? String(tx.occurredAt).slice(0, 10) : "unknown-date";
      return `- ${occurred} ${tx.merchantName || "Unknown"} ${formatUsd(Number(tx.amount ?? 0))} ${humaniseLabel(
        tx.category || "Uncategorized",
      )}`;
    })
    .join("\n");

  return [
    "Financial snapshot:",
    `Income: ${formatUsd(income, { absolute: true })}`,
    `Spend: ${formatUsd(expense, { absolute: true })}`,
    `Net: ${formatUsd(net)}`,
    "",
    "Top categories:",
    categoryLines || "- none",
    "",
    "Top merchants:",
    merchantLines || "- none",
    "",
    "Anomalies:",
    anomalyLines || "- none",
    "",
    `Recent transactions (latest ${Math.min(HIGHLIGHT_TRANSACTIONS_LIMIT, transactions.length)}):`,
    transactionLines || "- none",
    "",
    "Return JSON only.",
  ].join("\n");
}

function parseAiHighlightResponse(raw, fallback) {
  if (!raw) return null;
  let text;
  if (typeof raw === "string") {
    text = raw.trim();
  } else if (raw && typeof raw === "object") {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = "";
    }
  }
  if (!text) return null;

  if (text.startsWith("```")) {
    const firstNl = text.indexOf("\n");
    if (firstNl >= 0) {
      text = text.slice(firstNl + 1);
    }
    const lastFence = text.lastIndexOf("```");
    if (lastFence >= 0) {
      text = text.slice(0, lastFence);
    }
    text = text.trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const highlight = {
    title: fallback.title,
    summary: fallback.summary,
    sentiment: fallback.sentiment,
    recommendations: Array.isArray(fallback.recommendations) ? [...fallback.recommendations] : [],
  };

  if (typeof parsed.title === "string" && parsed.title.trim()) {
    highlight.title = parsed.title.trim();
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    highlight.summary = parsed.summary.trim();
  }
  if (typeof parsed.sentiment === "string") {
    const candidate = parsed.sentiment.trim().toUpperCase();
    if (candidate === "POSITIVE" || candidate === "NEUTRAL" || candidate === "NEGATIVE") {
      highlight.sentiment = candidate;
    }
  }
  if (Array.isArray(parsed.recommendations)) {
    const cleaned = parsed.recommendations
      .map((item) => (typeof item === "string" ? item.trim() : null))
      .filter(Boolean);
    if (cleaned.length > 0) {
      highlight.recommendations = Array.from(new Set(cleaned)).slice(0, 6);
    }
  }
  return highlight;
}

function shouldGenerateAiHighlight(query) {
  if (!query) return false;
  const raw =
    query.generateAi ??
    query.generateai ??
    query.generate_ai ??
    query.generate_ai_summary ??
    query.generateAISummary ??
    "";
  if (raw === true) return true;
  if (raw === false) return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function hasGeminiHighlightCredentials() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY);
}

function hasOpenAiHighlightCredentials() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY);
}

async function generateAiHighlightForSummary(summary, transactions, traceId) {
  const fallback = buildDeterministicHighlight(summary?.totals, summary?.byCategory, summary?.topMerchants);
  const provider = (process.env.SAFEPOCKET_AI_PROVIDER || "gemini").toLowerCase();
  const model = process.env.SAFEPOCKET_AI_MODEL || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-4.1-mini");
  const prompt = buildHighlightPrompt(summary, transactions);

  try {
    let raw;
    if (provider === "gemini") {
      if (!hasGeminiHighlightCredentials()) {
        console.warn("[analytics] Gemini highlight requested but no API key configured");
        return fallback;
      }
      raw = await callGeminiHighlight(model, prompt, HIGHLIGHT_MAX_TOKENS, traceId);
    } else {
      if (!hasOpenAiHighlightCredentials()) {
        console.warn("[analytics] OpenAI highlight requested but no API key configured");
        return fallback;
      }
      raw = await callOpenAiHighlight(model, prompt, HIGHLIGHT_MAX_TOKENS, traceId);
    }
    if (!raw) {
      return fallback;
    }
    const parsed = parseAiHighlightResponse(raw, fallback);
    return parsed || fallback;
  } catch (error) {
    console.warn("[analytics] AI highlight generation failed", { message: error?.message, traceId });
    return fallback;
  }
}

function summarise(transactions, fromDate, toDate, monthLabel, traceId) {
  console.log("[summarise] monthLabel:", monthLabel, "fromDate:", fromDate?.toISOString?.(), "toDate:", toDate?.toISOString?.());
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
  const totals = { income: round(income), expense: round(expense), net: round(net) };
  const fallbackHighlight = buildDeterministicHighlight(totals, categories, merchants);

  // If no monthLabel provided, use current month instead of 1970
  const effectiveMonth = monthLabel || new Date().toISOString().slice(0, 7);
  console.log("[summarise] effectiveMonth:", effectiveMonth);
  return {
    month: effectiveMonth,
    totals,
    byCategory: categories,
    topMerchants: merchants,
    anomalies: [],
    aiHighlight: fallbackHighlight,
    latestHighlight: null,
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

function buildStubTransactions(userId) {
  const now = new Date();
  const todayDate = now.getUTCDate();
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  
  // For current month, only generate transactions up to today
  const addDays = (days, offsetMs = 0) => {
    if (days > todayDate) return null; // Skip future dates
    return new Date(anchor + (days - 1) * DAY_MS + offsetMs).toISOString();
  };
  
  const prevMonth = (monthsBack, day) => {
    const d = new Date(anchor);
    d.setUTCMonth(d.getUTCMonth() - monthsBack);
    d.setUTCDate(day);
    return d.toISOString();
  };
  const primaryAccount = crypto.randomUUID();
  const creditCard = crypto.randomUUID();
  const savings = crypto.randomUUID();

  const transactions = [];
  
  // Helper to add transaction (skips if date is null/future)
  const addTx = (accountId, merchantName, amount, occurredAt, category, description, pending = false) => {
    if (!occurredAt) return; // Skip future dates
    transactions.push({
      id: crypto.randomUUID(),
      userId,
      accountId,
      merchantName,
      amount,
      currency: "USD",
      occurredAt,
      authorizedAt: occurredAt,
      pending,
      category,
      description,
      notes: null,
      anomalyScore: null,
    });
  };

  // ===== Current Month (only up to today) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, addDays(1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, addDays(15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, addDays(3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -145.50, addDays(8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, addDays(10), "Utilities", "Internet service");
  addTx(primaryAccount, "Blue Bottle Coffee", -8.75, addDays(2), "Dining", "Latte");
  addTx(primaryAccount, "Blue Bottle Coffee", -12.50, addDays(6), "Dining", "Coffee and pastry");
  addTx(primaryAccount, "Blue Bottle Coffee", -9.25, addDays(12), "Dining", "Cappuccino");
  addTx(primaryAccount, "Whole Foods Market", -156.32, addDays(5), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -89.47, addDays(12), "Groceries", "Mid-week restock");
  addTx(primaryAccount, "Trader Joes", -72.18, addDays(9), "Groceries", "Snacks and essentials");
  addTx(primaryAccount, "Uber Technologies", -24.50, addDays(4), "Transport", "Ride to downtown");
  addTx(primaryAccount, "Uber Technologies", -18.75, addDays(11), "Transport", "Ride to airport");
  addTx(primaryAccount, "Shell Gas Station", -52.40, addDays(7), "Transport", "Gas fill-up");
  addTx(creditCard, "Netflix", -15.99, addDays(2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, addDays(3), "Entertainment", "Premium subscription");
  addTx(creditCard, "Amazon", -145.99, addDays(8), "Shopping", "Household items");
  addTx(creditCard, "Amazon", -67.50, addDays(14), "Shopping", "Books and electronics");
  addTx(creditCard, "Target", -89.32, addDays(6), "Shopping", "Home goods");
  addTx(creditCard, "Chipotle", -14.25, addDays(5), "Dining", "Lunch");
  addTx(creditCard, "Olive Garden", -48.75, addDays(9), "Dining", "Dinner with friends");
  addTx(savings, "Auto Transfer", -500.00, addDays(2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, addDays(1), "Health", "Monthly membership");
  addTx(creditCard, "CVS Pharmacy", -32.45, addDays(7), "Health", "Prescriptions");

  // ===== Previous Month (-1) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(1, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(1, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(1, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -132.80, prevMonth(1, 8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(1, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Whole Foods Market", -178.45, prevMonth(1, 4), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -95.23, prevMonth(1, 11), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -112.67, prevMonth(1, 18), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Trader Joes", -68.90, prevMonth(1, 7), "Groceries", "Organic produce");
  addTx(primaryAccount, "Blue Bottle Coffee", -10.50, prevMonth(1, 5), "Dining", "Coffee");
  addTx(primaryAccount, "Blue Bottle Coffee", -8.75, prevMonth(1, 12), "Dining", "Latte");
  addTx(primaryAccount, "Starbucks", -7.45, prevMonth(1, 19), "Dining", "Frappuccino");
  addTx(creditCard, "Amazon", -234.56, prevMonth(1, 6), "Shopping", "Electronics");
  addTx(creditCard, "Amazon", -45.99, prevMonth(1, 14), "Shopping", "Books");
  addTx(creditCard, "Best Buy", -299.99, prevMonth(1, 20), "Shopping", "Headphones");
  addTx(creditCard, "Netflix", -15.99, prevMonth(1, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(1, 3), "Entertainment", "Premium subscription");
  addTx(creditCard, "AMC Theatres", -32.00, prevMonth(1, 16), "Entertainment", "Movie night");
  addTx(primaryAccount, "Uber Technologies", -28.90, prevMonth(1, 9), "Transport", "Ride to meeting");
  addTx(primaryAccount, "Lyft", -22.50, prevMonth(1, 17), "Transport", "Airport ride");
  addTx(primaryAccount, "Shell Gas Station", -48.75, prevMonth(1, 13), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(1, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(1, 1), "Health", "Monthly membership");
  addTx(creditCard, "Sushi Palace", -65.80, prevMonth(1, 21), "Dining", "Dinner");

  // ===== 2 Months Ago (-2) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(2, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(2, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Freelance Project", 850.00, prevMonth(2, 22), "Income", "Side project payment");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(2, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -118.45, prevMonth(2, 8), "Utilities", "Electric bill");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(2, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Water Company", -45.00, prevMonth(2, 12), "Utilities", "Water bill");
  addTx(primaryAccount, "Whole Foods Market", -145.67, prevMonth(2, 5), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -88.34, prevMonth(2, 12), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Costco", -287.45, prevMonth(2, 19), "Groceries", "Bulk shopping");
  addTx(creditCard, "Delta Airlines", -425.00, prevMonth(2, 10), "Travel", "Flight to NYC");
  addTx(creditCard, "Airbnb", -320.00, prevMonth(2, 14), "Travel", "NYC accommodation");
  addTx(creditCard, "Amazon", -156.78, prevMonth(2, 7), "Shopping", "Various items");
  addTx(creditCard, "Apple Store", -129.00, prevMonth(2, 18), "Shopping", "AirPods case");
  addTx(creditCard, "Netflix", -15.99, prevMonth(2, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(2, 3), "Entertainment", "Premium subscription");
  addTx(primaryAccount, "Uber Technologies", -42.30, prevMonth(2, 6), "Transport", "Ride");
  addTx(primaryAccount, "Shell Gas Station", -55.20, prevMonth(2, 15), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(2, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(2, 1), "Health", "Monthly membership");

  // ===== 3 Months Ago (-3) =====
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(3, 1), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "Acme Corp Payroll", 4200.00, prevMonth(3, 15), "Income", "Bi-weekly payroll deposit");
  addTx(primaryAccount, "City Apartments", -1850.00, prevMonth(3, 3), "Housing", "Monthly rent");
  addTx(primaryAccount, "Utility Power Co", -156.90, prevMonth(3, 8), "Utilities", "Electric bill (AC season)");
  addTx(primaryAccount, "Comcast Xfinity", -89.99, prevMonth(3, 10), "Utilities", "Internet service");
  addTx(primaryAccount, "Whole Foods Market", -167.89, prevMonth(3, 4), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -134.56, prevMonth(3, 11), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Whole Foods Market", -98.23, prevMonth(3, 18), "Groceries", "Weekly groceries");
  addTx(primaryAccount, "Trader Joes", -76.45, prevMonth(3, 25), "Groceries", "Specialty items");
  addTx(creditCard, "Amazon", -89.99, prevMonth(3, 5), "Shopping", "Home office supplies");
  addTx(creditCard, "IKEA", -456.78, prevMonth(3, 12), "Shopping", "Furniture");
  addTx(creditCard, "Netflix", -15.99, prevMonth(3, 2), "Entertainment", "Monthly subscription");
  addTx(creditCard, "Spotify", -10.99, prevMonth(3, 3), "Entertainment", "Premium subscription");
  addTx(creditCard, "Concert Tickets", -150.00, prevMonth(3, 20), "Entertainment", "Live show");
  addTx(primaryAccount, "Uber Technologies", -35.60, prevMonth(3, 7), "Transport", "Ride");
  addTx(primaryAccount, "Lyft", -28.90, prevMonth(3, 14), "Transport", "Ride");
  addTx(primaryAccount, "Shell Gas Station", -62.30, prevMonth(3, 21), "Transport", "Gas");
  addTx(savings, "Auto Transfer", -500.00, prevMonth(3, 2), "Transfer", "Monthly savings transfer");
  addTx(primaryAccount, "Gym Membership", -49.99, prevMonth(3, 1), "Health", "Monthly membership");
  addTx(creditCard, "Doctor Visit", -150.00, prevMonth(3, 16), "Health", "Annual checkup copay");

  return transactions;
}

function buildStubAccounts(userId) {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      name: "Primary Checking",
      institution: "Chase Bank",
      balance: 8542.67,
      currency: "USD",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "Rewards Credit Card",
      institution: "American Express",
      balance: -1847.23,
      currency: "USD",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: "High Yield Savings",
      institution: "Ally Bank",
      balance: 15230.00,
      currency: "USD",
      createdAt: now,
    },
  ];
}

function mapChatRow(row) {
  const createdAt =
    row.created_at instanceof Date && !Number.isNaN(row.created_at.getTime())
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString();
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt,
  };
}

function truncateText(value, limit) {
  if (typeof value !== "string") return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[...truncated...]`;
}

async function getConversationForClient(client, requestedConversationId) {
  let conversationId = requestedConversationId;
  let rows = [];
  if (conversationId) {
    const res = await client.query(
      `SELECT id, conversation_id, role, content, created_at
       FROM chat_messages
       WHERE conversation_id = $1
         AND user_id = current_setting('appsec.user_id', true)::uuid
       ORDER BY created_at ASC`,
      [conversationId],
    );
    rows = res.rows;
  } else {
    const latest = await client.query(
      `SELECT conversation_id
       FROM chat_messages
       WHERE user_id = current_setting('appsec.user_id', true)::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (latest.rowCount > 0) {
      conversationId = latest.rows[0].conversation_id;
      const res = await client.query(
        `SELECT id, conversation_id, role, content, created_at
         FROM chat_messages
         WHERE conversation_id = $1
           AND user_id = current_setting('appsec.user_id', true)::uuid
         ORDER BY created_at ASC`,
        [conversationId],
      );
      rows = res.rows;
    } else {
      conversationId = crypto.randomUUID();
      rows = [];
    }
  }
  return { conversationId, messages: rows.map(mapChatRow) };
}

async function deleteConversationTail(client, messageId) {
  if (!messageId) return null;
  const res = await client.query(
    `SELECT conversation_id, created_at
     FROM chat_messages
     WHERE id = $1
       AND user_id = current_setting('appsec.user_id', true)::uuid
     LIMIT 1`,
    [messageId],
  );
  if (res.rowCount === 0) {
    return null;
  }
  const { conversation_id: conversationId, created_at: createdAt } = res.rows[0];
  await client.query(
    `DELETE FROM chat_messages
     WHERE conversation_id = $1
       AND user_id = current_setting('appsec.user_id', true)::uuid
       AND created_at >= $2`,
    [conversationId, createdAt],
  );
  return conversationId;
}

function selectHistoryForAi(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const limit = Math.max(CHAT_MAX_HISTORY_MESSAGES, 0);
  if (limit === 0) return [];
  const trimmed = messages.slice(0, -1); // exclude the most recent (current user message)
  const start = Math.max(0, trimmed.length - limit * 2);
  return trimmed.slice(start);
}

async function gatherChatContext(client, userId) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  let transactions = [];
  try {
    transactions = await queryTransactionsWithClient(client, start, now);
  } catch (error) {
    console.warn("[chat] failed to load transactions for context", { message: error?.message });
  }
  const traceId = crypto.randomUUID();
  let summary = null;
  try {
    summary = summarise(transactions, start, now, null, traceId);
  } catch (error) {
    console.warn("[chat] failed to summarise transactions", { message: error?.message });
  }
  const recentTransactions = transactions.slice(0, 25).map((tx) => ({
    id: tx.id,
    occurredAt: tx.occurredAt,
    merchant: tx.merchantName,
    amount: tx.amount,
    category: tx.category,
    pending: tx.pending,
  }));
  return { summary, recentTransactions };
}

function formatHistoryForProvider(history) {
  return history.map((msg) => ({
    role: msg.role === "ASSISTANT" ? "assistant" : "user",
    content: truncateText(msg.content || "", CHAT_HISTORY_CHAR_LIMIT),
  }));
}

async function callGeminiHighlight(model, prompt, maxTokens, traceId) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[analytics] Gemini highlight requested but no API key configured");
    return null;
  }
  const base = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `${base}/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    systemInstruction: { parts: [{ text: HIGHLIGHT_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature: 0.35,
      responseMimeType: "application/json",
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[analytics] Gemini highlight response not ok", { status: res.status, body: text });
      return null;
    }
    const data = await res.json();
    if (Array.isArray(data.candidates) && data.candidates.length > 0) {
      for (const candidate of data.candidates) {
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part.text === "string" && part.text.trim()) {
              return part.text.trim();
            }
            if (part.json) {
              try {
                return JSON.stringify(part.json);
              } catch {
                // ignore
              }
            }
            if (part.struct) {
              try {
                return JSON.stringify(part.struct);
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }
    if (Array.isArray(data.output_text) && data.output_text.length > 0) {
      return data.output_text.join("\n").trim();
    }
    if (Array.isArray(data.contents) && data.contents.length > 0) {
      const first = data.contents[0];
      if (Array.isArray(first?.parts)) {
        const textPart = first.parts.find((part) => typeof part.text === "string" && part.text.trim());
        if (textPart?.text) {
          return textPart.text.trim();
        }
      }
    }
    return null;
  } catch (error) {
    console.warn("[analytics] Gemini highlight call failed", { message: error?.message, traceId });
    return null;
  }
}

async function callOpenAiHighlight(model, prompt, maxTokens, traceId) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY;
  if (!apiKey) {
    console.warn("[analytics] OpenAI highlight requested but no API key configured");
    return null;
  }
  const endpoint = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://api.openai.com/v1/responses").replace(/\/+$/, "");
  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: HIGHLIGHT_SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
    ],
    max_output_tokens: Math.min(maxTokens, 1000),
    temperature: 0.35,
  };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[analytics] OpenAI highlight response not ok", { status: res.status, body: text });
      return null;
    }
    const data = await res.json();
    if (Array.isArray(data.output_text) && data.output_text.length > 0) {
      return data.output_text.join("\n").trim();
    }
    if (Array.isArray(data.output) && data.output.length > 0) {
      const first = data.output[0];
      if (Array.isArray(first?.content) && first.content.length > 0) {
        const textNode = first.content.find((part) => typeof part.text === "string" && part.text.trim());
        if (textNode?.text) {
          return textNode.text.trim();
        }
      }
    }
    if (Array.isArray(data.content) && data.content.length > 0) {
      const textNode = data.content.find((part) => typeof part.text === "string" && part.text.trim());
      if (textNode?.text) {
        return textNode.text.trim();
      }
    }
    if (typeof data.response === "string" && data.response.trim()) {
      return data.response.trim();
    }
    return null;
  } catch (error) {
    console.warn("[analytics] OpenAI highlight call failed", { message: error?.message, traceId });
    return null;
  }
}

async function callGemini(model, contextText, history, userMessage, maxTokens, traceId) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.SAFEPOCKET_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[chat] Gemini requested but no API key configured");
    return null;
  }
  const base = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `${base}/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const contents = [];
  contents.push({
    role: "user",
    parts: [{ text: `Context JSON:\n${contextText}` }],
  });
  history.forEach((msg) => {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  });
  contents.push({ role: "user", parts: [{ text: userMessage }] });
  const payload = {
    systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature: 0.6,
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[chat] Gemini response not ok", { status: res.status, body: text });
      return null;
    }
    const data = await res.json();
    if (Array.isArray(data.candidates) && data.candidates.length > 0) {
      const candidate = data.candidates.find((c) => c.content?.parts?.length) || data.candidates[0];
      if (candidate?.content?.parts?.length) {
        const textPart = candidate.content.parts.find((part) => typeof part.text === "string");
        if (textPart?.text) return textPart.text.trim();
      }
    }
    if (Array.isArray(data.contents) && data.contents.length > 0) {
      const first = data.contents[0];
      if (first?.parts?.length) {
        const textPart = first.parts.find((part) => typeof part.text === "string");
        if (textPart?.text) return textPart.text.trim();
      }
    }
    return null;
  } catch (error) {
    console.warn("[chat] Gemini call failed", { message: error?.message, traceId });
    return null;
  }
}

async function callOpenAi(model, contextText, history, userMessage, maxTokens, traceId) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.SAFEPOCKET_AI_KEY;
  if (!apiKey) {
    console.warn("[chat] OpenAI requested but no API key configured");
    return null;
  }
  const endpoint = (process.env.SAFEPOCKET_AI_ENDPOINT || "https://api.openai.com/v1/responses").replace(/\/+$/, "");
  const input = [
    {
      role: "system",
      content: [{ type: "text", text: CHAT_SYSTEM_PROMPT }],
    },
    {
      role: "system",
      content: [{ type: "text", text: `Context JSON:\n${contextText}` }],
    },
  ];
  history.forEach((msg) => {
    input.push({
      role: msg.role,
      content: [{ type: "text", text: msg.content }],
    });
  });
  input.push({
    role: "user",
    content: [{ type: "text", text: userMessage }],
  });
  const payload = {
    model,
    input,
    max_output_tokens: maxTokens,
  };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[chat] OpenAI response not ok", { status: res.status, body: text });
      return null;
    }
    const data = await res.json();
    if (typeof data.output_text === "string" && data.output_text.trim().length > 0) {
      return data.output_text.trim();
    }
    if (Array.isArray(data.output)) {
      const parts = [];
      for (const item of data.output) {
        if (item?.content) {
          for (const part of item.content) {
            const text = part?.text || part?.output_text;
            if (typeof text === "string") {
              parts.push(text);
            }
          }
        }
      }
      if (parts.length > 0) {
        return parts.join("\n").trim();
      }
    }
    return null;
  } catch (error) {
    console.warn("[chat] OpenAI call failed", { message: error?.message, traceId });
    return null;
  }
}

async function callAiAssistant(history, userMessage, context, traceId) {
  const provider = (process.env.SAFEPOCKET_AI_PROVIDER || "gemini").toLowerCase();
  const model = process.env.SAFEPOCKET_AI_MODEL || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-4.1-mini");
  const maxTokens = CHAT_DEFAULT_MAX_TOKENS;
  const contextJson = JSON.stringify(context, null, 2);
  const contextText =
    contextJson.length > CHAT_CONTEXT_CHAR_LIMIT
      ? `${contextJson.slice(0, CHAT_CONTEXT_CHAR_LIMIT)}\n[context truncated]`
      : contextJson;
  const formattedHistory = formatHistoryForProvider(history);
  if (provider === "gemini") {
    return callGemini(model, contextText, formattedHistory, userMessage, maxTokens, traceId);
  }
  return callOpenAi(model, contextText, formattedHistory, userMessage, maxTokens, traceId);
}

function buildFallbackReply(context) {
  if (!context || !context.summary) {
    return "I couldn't retrieve enough data to answer right now. Please try again in a moment.";
  }
  const { summary } = context;
  const totals = summary?.totals || { income: 0, expense: 0, net: 0 };
  const topCategory = summary?.byCategory?.[0];
  const topMerchant = summary?.topMerchants?.[0];
  const lines = [
    `Here's what I can see from your recent activity:`,
    `• Income: $${totals.income.toFixed(2)}, Expenses: $${Math.abs(totals.expense).toFixed(2)}, Net: $${totals.net.toFixed(2)}.`,
  ];
  if (topCategory) {
    lines.push(`• Biggest spending category: ${topCategory.category} at $${Math.abs(topCategory.amount).toFixed(2)}.`);
  }
  if (topMerchant) {
    lines.push(`• Top merchant: ${topMerchant.merchant} with $${Math.abs(topMerchant.amount).toFixed(2)} spent.`);
  }
  lines.push("Let me know if you'd like to dive deeper into any of these details!");
  return lines.join(" ");
}

async function generateAssistantReplyForLambda(client, userId, conversationId, userMessage, priorMessages, traceId) {
  const context = await gatherChatContext(client, userId);
  const aiReply = await callAiAssistant(priorMessages, userMessage, context, traceId);
  if (aiReply && aiReply.trim()) {
    return aiReply.trim();
  }
  return buildFallbackReply(context);
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
  const generateAi = shouldGenerateAiHighlight(query);
  console.log("[handleAnalyticsSummary] generateAi:", generateAi, "query.generateAi:", query?.generateAi);
  try {
    const transactions = await queryTransactions(payload.sub, fromDate, toDate);
    const summary = summarise(transactions, fromDate, toDate, monthLabel, traceId);
    if (generateAi) {
      console.log("[handleAnalyticsSummary] Generating AI highlight...");
      const aiHighlight = await generateAiHighlightForSummary(summary, transactions, traceId);
      console.log("[handleAnalyticsSummary] AI highlight result:", aiHighlight ? "generated" : "null");
      if (aiHighlight) {
        summary.aiHighlight = aiHighlight;
        // Also set latestHighlight so the frontend can display it properly
        summary.latestHighlight = {
          month: monthLabel || summary.month,
          highlight: aiHighlight,
        };
      }
    }
    return respond(event, 200, summary);
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "ANALYTICS_FETCH_FAILED",
        message: error?.message || "Failed to load analytics summary",
        traceId,
      },
    });
  }
}

async function handleTransactions(event, query) {
  console.log("[handleTransactions] Received query:", JSON.stringify(query));
  const payload = await authenticate(event);
  const { fromDate, toDate, monthLabel } = parseRange(query);
  console.log("[handleTransactions] Parsed range:", { fromDate: fromDate?.toISOString(), toDate: toDate?.toISOString(), monthLabel });
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const transactions = await queryTransactions(payload.sub, fromDate, toDate);
    const page = Math.max(parseInt(query.page || "0", 10), 0);
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || "15", 10), 1), 100);
    const start = page * pageSize;
    const paged = transactions.slice(start, start + pageSize);
    return respond(event, 200, {
      transactions: paged,
      period: {
        month: monthLabel,
        from: monthLabel ? null : toIsoDate(fromDate),
        to: monthLabel ? null : toIsoDate(new Date(toDate.getTime() - 1)),
      },
      aggregates: buildTransactionsAggregates(transactions),
      traceId,
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "TRANSACTIONS_FETCH_FAILED",
        message: error?.message || "Failed to load transactions",
        traceId,
      },
    });
  }
}

async function handleAccounts(event) {
  const payload = await authenticate(event);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    const accounts = await withUserClient(payload.sub, async (client) => {
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
    return respond(event, 200, { accounts, traceId });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "ACCOUNTS_FETCH_FAILED",
        message: error?.message || "Failed to load accounts",
        traceId,
      },
    });
  }
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

async function plaidFetch(path, body) {
  const { plaid } = await loadConfig();
  if (!plaid.clientId || !plaid.clientSecret) {
    throw createHttpError(500, "Plaid credentials not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAID_TIMEOUT_MS);
  try {
    const response = await fetch(`${plaid.baseUrl || "https://sandbox.plaid.com"}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Plaid-Version": process.env.PLAID_VERSION || "2020-09-14",
      },
      body: JSON.stringify({ client_id: plaid.clientId, secret: plaid.clientSecret, ...body }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const err = createHttpError(
        response.status,
        typeof payload === "string" ? payload : payload?.error_message || payload?.message || "Plaid request failed",
      );
      err.payload = payload;
      throw err;
    }
    return payload ?? {};
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      const timeoutErr = createHttpError(504, "Plaid request timed out");
      timeoutErr.payload = { error: { code: "PLAID_TIMEOUT", message: "Plaid request timed out" } };
      throw timeoutErr;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function handlePlaidLinkToken(event) {
  const payload = isAuthOptional() ? { sub: ANON_USER_ID } : await authenticate(event);
  const { plaid } = await loadConfig();
  const products = parseList(plaid.products, ["transactions"]);
  const countryCodes = parseList(plaid.countryCodes, ["US"]);
  const clientUserId =
    typeof payload.sub === "string" && payload.sub.trim().length > 0
      ? payload.sub.replace(/-/g, "").slice(0, 24)
      : crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  try {
    const response = await plaidFetch("/link/token/create", {
      user: { client_user_id: clientUserId },
      client_name: plaid.clientName || "Safepocket",
      language: "en",
      products,
      country_codes: countryCodes,
      redirect_uri: plaid.redirectUri || undefined,
      webhook: plaid.webhookUrl || undefined,
    });
    return respond(event, 200, {
      linkToken: response.link_token,
      expiration: response.expiration,
      requestId: response.request_id ?? null,
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
  const auth = await authenticate(event);
  const wantSync = String(event.queryStringParameters?.sync || "").trim() === "1";
  const body = parseJsonBody(event);
  const publicToken = body.publicToken || body.public_token;
  if (!publicToken || typeof publicToken !== "string") {
    return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "publicToken is required" } });
  }
  try {
    const exchange = await plaidFetch("/item/public_token/exchange", { public_token: publicToken });
    const accessToken = exchange.access_token;
    const itemId = exchange.item_id;
    if (!accessToken || !itemId) {
      throw createHttpError(502, "Plaid exchange response missing access_token or item_id");
    }
    const encryptedToken = await encryptSecret(accessToken);
    await withUserClient(auth.sub, async (client) => {
      await ensureUserRow(client, auth);
      const tokenColumn = await resolvePlaidTokenColumn(client);
      await client.query(`DELETE FROM plaid_items WHERE user_id = current_setting('appsec.user_id', true)::uuid`);
      const insertSql = `
        INSERT INTO plaid_items (user_id, item_id, ${tokenColumn})
        VALUES (current_setting('appsec.user_id', true)::uuid, $1, $2)
        ON CONFLICT (item_id)
        DO UPDATE SET user_id = EXCLUDED.user_id, ${tokenColumn} = EXCLUDED.${tokenColumn}`;
      await client.query(insertSql, [itemId, encryptedToken]);
    });
    if (wantSync) {
      const syncEvent = {
        ...event,
        body: JSON.stringify({}),
        httpMethod: "POST",
      };
      return await handleTransactionsSync(syncEvent);
    }
    return respond(event, 200, {
      itemId,
      status: "SUCCESS",
      requestId: exchange.request_id ?? null,
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
function resolveLedgerBaseUrl() {
  const base =
    process.env.LEDGER_SERVICE_INTERNAL_URL ||
    process.env.LEDGER_SERVICE_URL ||
    process.env.NEXT_PUBLIC_LEDGER_BASE;
  if (!base) {
    throw createHttpError(500, "Ledger service base URL is not configured");
  }
  return base.replace(/\/+$/, "");
}

async function fetchLedgerJson(path, options = {}) {
  const base = resolveLedgerBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(`${base}${path.startsWith("/") ? path : "/" + path}`, { ...options, signal: controller.signal });
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        const timeoutErr = createHttpError(504, "Ledger upstream request timed out");
        timeoutErr.payload = { error: { code: "LEDGER_TIMEOUT", message: "Ledger upstream request timed out" } };
        throw timeoutErr;
      }
      throw error;
    }
    const textBody = await response.text();
    let payload = null;
    if (textBody) {
      try {
        payload = JSON.parse(textBody);
      } catch {
        payload = textBody;
      }
    }
    if (!response.ok) {
      const err = createHttpError(response.status, typeof payload === "string" ? payload : payload?.error?.message || payload?.message || "Ledger service request failed");
      err.payload = payload;
      throw err;
    }
    return { status: response.status, payload: payload ?? {} };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}


// ===== [DB diagnostics helpers - TEMPORARY] =====
async function checkPlaidItems(client) {
  const constraints = await client.query(
    "SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'plaid_items' AND c.contype = 'u' ORDER BY conname",
  );
  const dupItem = await client.query(
    "SELECT item_id, COUNT(*) AS cnt FROM plaid_items GROUP BY item_id HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 50",
  );
  const dupUserItem = await client.query(
    "SELECT user_id, item_id, COUNT(*) AS cnt FROM plaid_items GROUP BY user_id, item_id HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 50",
  );
  return {
    constraints: constraints.rows,
    dupByItem: dupItem.rows,
    dupByUserItem: dupUserItem.rows,
  };
}

async function ensurePlaidItemsConstraints(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plaid_items_item_unique'
      ) THEN
        ALTER TABLE plaid_items
          ADD CONSTRAINT plaid_items_item_unique UNIQUE (item_id);
      END IF;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plaid_items_user_item_unique'
      ) THEN
        ALTER TABLE plaid_items
          ADD CONSTRAINT plaid_items_user_item_unique UNIQUE (user_id, item_id);
      END IF;
    END $$;
  `);
  await client.query("CREATE INDEX IF NOT EXISTS plaid_items_user_idx ON plaid_items(user_id)");
  return { ok: true };
}

async function handleDiagnosticsPlaidConfig(event) {
  const { plaid } = await loadConfig();
  const resolved = {
    env: plaid.env,
    baseUrl: plaid.baseUrl,
    hasClientSecret: Boolean(plaid.clientSecret && plaid.clientSecret.trim()),
    clientSecretLength: (plaid.clientSecret || "").length,
    products: parseList(plaid.products, ["transactions"]),
    countryCodes: parseList(plaid.countryCodes, ["US"]),
  };
  return respond(event, 200, { resolved });
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

async function handleDiagnosticsAuth(event) {
  const headers = event.headers || {};
  const rawAuth = headers.authorization || headers.Authorization || "";
  const normalizeBearer = (value) =>
    typeof value === "string" && value.trim().toLowerCase().startsWith("bearer ")
      ? value.trim().slice(7).trim()
      : value.trim();
  const cookies = parseCookies(event);
  const cookieToken = cookies.get("sp_token") || "";
  const looksJwt = (value) => typeof value === "string" && value.split(".").length === 3;
  const headerToken = normalizeBearer(rawAuth);
  try {
    const identity = await authenticate(event);
    return respond(event, 200, {
      ok: true,
      sub: identity.sub,
      tokenUse: identity.token_use || null,
      seen: {
        header: { present: Boolean(rawAuth), looksJwt: looksJwt(headerToken) },
        cookie: { present: Boolean(cookieToken), looksJwt: looksJwt(cookieToken) },
      },
    });
  } catch (error) {
    return respond(
      event,
      error?.statusCode || error?.status || 401,
      {
        ok: false,
        error: error?.message || "Unauthorized",
        seen: {
          header: { present: Boolean(rawAuth), looksJwt: looksJwt(headerToken) },
          cookie: { present: Boolean(cookieToken), looksJwt: looksJwt(cookieToken) },
        },
      },
    );
  }
}

async function handleDiagnosticsDbMaintenance(event) {
  const headers = event.headers || {};
  const adminToken = process.env.DB_ADMIN_TOKEN || ADMIN_SQL_TOKEN;
  const supplied =
    headers["x-admin-token"] ||
    headers["X-Admin-Token"] ||
    headers["x-admin"] ||
    headers["X-Admin"] ||
    "";
  if (!adminToken || supplied !== adminToken) {
    return respond(event, 403, { error: "forbidden" });
  }

  try {
    const result = await withUserClient(ANON_USER_ID, (client) => ensurePlaidItemsConstraints(client));
    return respond(event, 200, { status: "ok", details: result });
  } catch (error) {
    console.error("[maint] failed to apply constraints", { code: error?.code, message: error?.message });
    return respond(event, 500, { error: error?.message || "constraint_update_failed", code: error?.code });
  }
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

  const requestedClientId =
    (typeof body.clientId === "string" && body.clientId.trim()) ||
    (typeof body.client_id === "string" && body.client_id.trim()) ||
    undefined;
  let usingNativeClient = false;
  let redirectUriUsed;
  let clientIdToUse = requestedClientId || cognito.clientId;

  const normalizeRedirect = (value) => (typeof value === "string" ? value.trim() : "");

  if (grantType === "authorization_code") {
    if (!body.code) throw createHttpError(400, "code is required for authorization_code");
    const redirectUri = body.redirectUri || cognito.redirectUri || cognito.redirectUriNative;
    if (!redirectUri) throw createHttpError(400, "redirectUri is required");
    redirectUriUsed = redirectUri;
    params.set("code", body.code);
    params.set("redirect_uri", redirectUri);
    if (body.codeVerifier) params.set("code_verifier", body.codeVerifier);
    const normalizedRedirect = normalizeRedirect(redirectUri).toLowerCase();
    const looksNative = normalizedRedirect && !normalizedRedirect.startsWith("http://") && !normalizedRedirect.startsWith("https://");
    if (looksNative && cognito.clientIdNative) {
      clientIdToUse = cognito.clientIdNative;
      usingNativeClient = true;
    } else if (!looksNative && cognito.clientIdWeb) {
      clientIdToUse = cognito.clientIdWeb;
    }
    console.log("[lambda] token exchange request", {
      redirectUri,
      hasCodeVerifier: Boolean(body.codeVerifier),
      hasClientSecret: Boolean(cognito.clientSecret && cognito.clientSecret.trim()),
      domain: cognito.domain,
      clientHint: requestedClientId,
    });
  } else {
    if (!body.refreshToken) throw createHttpError(400, "refreshToken is required for refresh_token");
    params.set("refresh_token", body.refreshToken);
    if (requestedClientId) {
      clientIdToUse = requestedClientId;
      const normalized = requestedClientId.toLowerCase();
      if (cognito.clientIdNative && normalized === cognito.clientIdNative.toLowerCase()) {
        usingNativeClient = true;
      }
    }
  }

  if (!clientIdToUse) {
    throw createHttpError(500, "Cognito client id not configured");
  }
  params.set("client_id", clientIdToUse);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (!usingNativeClient && cognito.clientSecret && cognito.clientSecret.trim()) {
    headers.Authorization = `Basic ${Buffer.from(`${clientIdToUse}:${cognito.clientSecret}`).toString("base64")}`;
  }

  const tokenUrl = `${cognito.domain}/oauth2/token`;
  console.log("[lambda] token exchange request", {
    tokenUrl,
    grantType,
    hasClientSecret: Boolean(!usingNativeClient && cognito.clientSecret && cognito.clientSecret.trim()),
    redirectUri: redirectUriUsed || params.get("redirect_uri"),
    clientId: clientIdToUse,
    usingNativeClient,
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
  const usingBasicAuth = Boolean(cognito.clientSecret);
  if (usingBasicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${cognito.clientId}:${cognito.clientSecret}`).toString("base64")}`;
  }

  const tokenUrl = `${cognito.domain}/oauth2/token`;
  console.info("[/auth/callback] exchanging code", {
    tokenUrl,
    redirectUri: cognito.redirectUri,
    clientId: cognito.clientId,
    hasClientSecret: Boolean(cognito.clientSecret && cognito.clientSecret.trim()),
    usingBasicAuth,
    clientSecretPreview: cognito.clientSecret ? `${cognito.clientSecret.slice(0, 4)}***${cognito.clientSecret.slice(-4)}` : null,
  });
  const payloadPreview = Object.fromEntries(
    Array.from(params.entries()).map(([key, value]) => (key === "code" ? [key, "***redacted***"] : [key, value])),
  );
  console.info("[/auth/callback] form payload", payloadPreview);
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
  const defaultOrigin = pickPreferredRedirectOrigin();
  let cookieDomainAttr = "";
  if (defaultOrigin) {
    try {
      const hostname = new URL(defaultOrigin).hostname;
      if (hostname && hostname.toLowerCase() !== "localhost") {
        cookieDomainAttr = `Domain=${hostname}; `;
      }
    } catch {
      // ignore parsing errors; fall back to no domain attr
    }
  }
  const cookieAttributes = `${cookieDomainAttr}Path=/; SameSite=None; Secure`;
  const primaryToken = tokenData.id_token || tokenData.access_token;
  if (tokenData.access_token) {
    cookies.push(`sp_at=${tokenData.access_token}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
  }
  if (primaryToken) {
    cookies.push(`sp_token=${primaryToken}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
  }
  if (tokenData.id_token) {
    cookies.push(`sp_it=${tokenData.id_token}; ${cookieAttributes}; HttpOnly; Max-Age=${maxAge}`);
  }
  if (tokenData.refresh_token) {
    cookies.push(`sp_rt=${tokenData.refresh_token}; ${cookieAttributes}; HttpOnly; Max-Age=${30 * 24 * 60 * 60}`);
  }

  const rawState = typeof query.state === "string" ? query.state : undefined;
  const redirectLocation = resolvePostAuthRedirect(rawState);
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
        redirectTo: redirectLocation,
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
      Location: redirectLocation,
    },
    cookies,
  });
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Helper to check if user is demo user
function isDemoUser(userId) {
  return userId === DEV_USER_ID;
}

async function handleChat(event) {
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const payload = await authenticate(event);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  const isDemo = isDemoUser(payload.sub);

  const respondWithError = (error) => {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "CHAT_OPERATION_FAILED",
        message: error?.message || "Chat operation failed",
        traceId,
      },
    });
  };

  // For demo users, always return empty history (don't persist chat)
  if (method === "GET") {
    if (isDemo) {
      // Demo users don't have persistent chat history
      return respond(event, 200, { 
        conversationId: crypto.randomUUID(), 
        messages: [], 
        traceId,
        isDemo: true 
      });
    }
    const requestedId = event.queryStringParameters?.conversationId;
    try {
      const conversationId = UUID_REGEX.test(requestedId || "") ? requestedId : null;
      const result = await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        return getConversationForClient(client, conversationId);
      });
      return respond(event, 200, { ...result, traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  if (method === "POST") {
    let body;
    try {
      body = parseJsonBody(event);
    } catch {
      return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } });
    }
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) {
      return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "message is required" } });
    }
    const rawConversationId = typeof body.conversationId === "string" && UUID_REGEX.test(body.conversationId) ? body.conversationId : null;
    const truncateId =
      typeof body.truncateFromMessageId === "string" && UUID_REGEX.test(body.truncateFromMessageId)
        ? body.truncateFromMessageId
        : null;

    // For demo users, don't persist chat - just generate response
    if (isDemo) {
      try {
        const result = await withUserClient(payload.sub, async (client) => {
          await ensureChatTables(client);
          await ensureUserRow(client, payload);
          
          const conversationId = rawConversationId || crypto.randomUUID();
          const nowIso = new Date().toISOString();
          
          // Get context for AI without saving to DB
          const assistantContent = await generateAssistantReplyForLambda(
            client,
            payload.sub,
            conversationId,
            rawMessage,
            [], // No prior messages for demo users
            traceId,
          );

          const userMessageId = crypto.randomUUID();
          const assistantId = crypto.randomUUID();
          const assistantCreatedAt = new Date().toISOString();

          // Return messages without persisting to DB
          return {
            conversationId,
            messages: [
              {
                id: userMessageId,
                role: "USER",
                content: rawMessage,
                createdAt: nowIso,
              },
              {
                id: assistantId,
                role: "ASSISTANT",
                content: assistantContent,
                createdAt: assistantCreatedAt,
              },
            ],
            isDemo: true,
          };
        });
        return respond(event, 200, { ...result, traceId });
      } catch (error) {
        return respondWithError(error);
      }
    }

    // Regular users - persist chat history
    try {
      const result = await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        let conversationId = rawConversationId;

        if (truncateId) {
          const truncatedConversationId = await deleteConversationTail(client, truncateId);
          if (truncatedConversationId) {
            conversationId = truncatedConversationId;
          }
        }

        if (!conversationId) {
          conversationId = crypto.randomUUID();
        }

        const nowIso = new Date().toISOString();
        const userMessageId = crypto.randomUUID();
        await client.query(
          `INSERT INTO chat_messages (id, conversation_id, user_id, role, content, created_at)
           VALUES ($1, $2, current_setting('appsec.user_id', true)::uuid, 'USER', $3, $4)`,
          [userMessageId, conversationId, rawMessage, nowIso],
        );

        const conversation = await getConversationForClient(client, conversationId);
        const messages = conversation.messages;
        const latestUserMessage = messages[messages.length - 1];
        const priorMessages = selectHistoryForAi(messages);
        const assistantContent = await generateAssistantReplyForLambda(
          client,
          payload.sub,
          conversationId,
          latestUserMessage?.content || rawMessage,
          priorMessages,
          traceId,
        );

        const assistantId = crypto.randomUUID();
        const assistantCreatedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO chat_messages (id, conversation_id, user_id, role, content, created_at)
           VALUES ($1, $2, current_setting('appsec.user_id', true)::uuid, 'ASSISTANT', $3, $4)`,
          [assistantId, conversationId, assistantContent, assistantCreatedAt],
        );

        const updatedMessages = messages.concat([
          {
            id: assistantId,
            role: "ASSISTANT",
            content: assistantContent,
            createdAt: assistantCreatedAt,
          },
        ]);

        return { conversationId, messages: updatedMessages };
      });

      return respond(event, 200, { ...result, traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  if (method === "DELETE") {
    try {
      const requestedId = event.queryStringParameters?.conversationId;
      await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        if (requestedId && UUID_REGEX.test(requestedId)) {
          await client.query(
            `DELETE FROM chat_messages
             WHERE user_id = current_setting('appsec.user_id', true)::uuid
               AND conversation_id = $1`,
            [requestedId],
          );
        } else {
          await client.query(
            `DELETE FROM chat_messages
             WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
          );
        }
      });
      return respond(event, 200, { status: "DELETED", traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  return respond(event, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported chat method" } });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

async function upsertAccount(client, accountId, name, institution) {
  await withSavepoint(client, "account", () =>
    client.query(
      `INSERT INTO accounts (id, user_id, name, institution)
       VALUES ($1, current_setting('appsec.user_id', true)::uuid, $2, $3)
       ON CONFLICT (id)
       DO UPDATE SET name = EXCLUDED.name, institution = EXCLUDED.institution`,
      [accountId, name, institution],
    ),
  );
}

async function handleTransactionsSync(event) {
  const auth = await authenticate(event);
  let options = {};
  try {
    options = parseJsonBody(event);
  } catch (error) {
    return respond(event, 400, {
      error: {
        code: "INVALID_SYNC_REQUEST",
        message: error?.message || "Invalid sync request payload",
      },
    });
  }
  const demoSeed = coerceBoolean(options.demoSeed);
  const forceFullSync = coerceBoolean(options.forceFullSync);
  const startMonthInput = typeof options.startMonth === "string" ? options.startMonth : undefined;
  const now = new Date();
  let syncStart;
  if (startMonthInput) {
    try {
      syncStart = parseMonth(startMonthInput);
    } catch {
      return respond(event, 400, {
        error: {
          code: "INVALID_SYNC_REQUEST",
          message: "Invalid startMonth format (expected YYYY-MM)",
        },
      });
    }
  } else if (forceFullSync) {
    syncStart = new Date(now.getTime() - 90 * DAY_MS);
  } else {
    syncStart = new Date(now.getTime() - 30 * DAY_MS);
  }
  const fromIso = toIsoDate(syncStart);
  const toIso = toIsoDate(now);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();

  if (demoSeed) {
    try {
      const result = await withUserClient(auth.sub, async (client) => {
        await ensureUserRow(client, auth);
        await client.query(
          `DELETE FROM transactions
           WHERE user_id = current_setting('appsec.user_id', true)::uuid
              OR account_id IN (
                SELECT id FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid
              )`,
        );
        await client.query(
          `DELETE FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );

        const stubTransactions = buildStubTransactions(auth.sub);
        console.log("[demo-sync] buildStubTransactions generated", stubTransactions.length, "transactions");
        
        // Log date range of transactions for debugging
        if (stubTransactions.length > 0) {
          const dates = stubTransactions.map(t => t.occurredAt).sort();
          console.log("[demo-sync] date range:", dates[0], "to", dates[dates.length - 1]);
        }
        
        const alternateAccountId = crypto.randomUUID();
        const demoNow = new Date();
        const demoAnchor = Date.UTC(demoNow.getUTCFullYear(), demoNow.getUTCMonth(), 1);
        stubTransactions.push(
          {
            id: hashToUuid(`demo:rent:${fromIso}`),
            userId: auth.sub,
            accountId: alternateAccountId,
            merchantName: "City Apartments",
            amount: -1450.0,
            currency: "USD",
            occurredAt: new Date(demoAnchor + 4 * DAY_MS).toISOString(),
            authorizedAt: new Date(demoAnchor + 4 * DAY_MS + 90 * 60 * 1000).toISOString(),
            pending: false,
            category: "Housing",
            description: "Monthly rent payment",
          },
          {
            id: hashToUuid(`demo:bonus:${fromIso}`),
            userId: auth.sub,
            accountId: alternateAccountId,
            merchantName: "Employer Bonus",
            amount: 500.0,
            currency: "USD",
            occurredAt: new Date(demoAnchor + 10 * DAY_MS).toISOString(),
            authorizedAt: new Date(demoAnchor + 10 * DAY_MS).toISOString(),
            pending: false,
            category: "Income",
            description: "Performance bonus",
          },
        );
        const stubAccounts = buildStubAccounts(auth.sub);
        const accountIterator = stubAccounts[Symbol.iterator]();
        const accountMap = new Map();

        for (const tx of stubTransactions) {
          if (!accountMap.has(tx.accountId)) {
            const template =
              accountIterator.next().value || {
                name: "Demo Checking",
                institution: "Safepocket Demo Bank",
                createdAt: new Date().toISOString(),
              };
            accountMap.set(tx.accountId, template);
          }
        }

        for (const [accountId, template] of accountMap.entries()) {
          await upsertAccount(client, accountId, template.name, template.institution);
        }

        const merchantCache = new Map();
        let upserted = 0;

        for (const tx of stubTransactions) {
          const merchantName = tx.merchantName || "Demo Merchant";
          let merchantId = merchantCache.get(merchantName);
      if (!merchantId) {
        const merchantUuid = hashToUuid(`merchant:${merchantName}`);
        try {
          const inserted = await withSavepoint(client, "merchant_demo", () =>
            client.query(
              `INSERT INTO merchants (id, name)
                   VALUES ($1, $2)
                   ON CONFLICT (id)
                   DO UPDATE SET name = EXCLUDED.name
                   RETURNING id`,
              [merchantUuid, merchantName],
            ),
          );
          merchantId = inserted.rows[0]?.id || merchantUuid;
        } catch (error) {
        console.warn("[lambda] demo merchant upsert fallback", { message: error?.message });
        const fallback = await client.query(`SELECT id FROM merchants WHERE name = $1 LIMIT 1`, [
          merchantName,
        ]);
        if (fallback.rows[0]?.id) {
          merchantId = fallback.rows[0].id;
        } else {
          const inserted = await client.query(
            `INSERT INTO merchants (id, name)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [merchantUuid, merchantName],
          );
          merchantId = inserted.rows[0]?.id || merchantUuid;
        }
            }
            merchantCache.set(merchantName, merchantId);
          }

          const amount = Number.isFinite(Number(tx.amount)) ? Number(tx.amount) : 0;
          const currency = (tx.currency || "USD").toUpperCase();
          const occurredAtIso = tx.occurredAt || new Date().toISOString();
          const authorizedAtIso = tx.authorizedAt || occurredAtIso;

          try {
            await withSavepoint(client, "txn_demo", () =>
              client.query(
                `INSERT INTO transactions
                   (id, user_id, account_id, merchant_id, amount, currency, occurred_at, authorized_at, pending, category, description)
                 VALUES
                   ($1, current_setting('appsec.user_id', true)::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (id)
                 DO UPDATE SET
                   account_id = EXCLUDED.account_id,
                   merchant_id = EXCLUDED.merchant_id,
                   amount = EXCLUDED.amount,
                   currency = EXCLUDED.currency,
                   occurred_at = EXCLUDED.occurred_at,
                   authorized_at = EXCLUDED.authorized_at,
                   pending = EXCLUDED.pending,
                   category = EXCLUDED.category,
                   description = EXCLUDED.description`,
                [
                  tx.id,
                  tx.accountId,
                  merchantId,
                  amount,
                  currency,
                  occurredAtIso,
                  authorizedAtIso,
                  Boolean(tx.pending),
                  tx.category || "General",
                  tx.description || merchantName,
                ],
              ),
            );
            upserted += 1;
          } catch (error) {
            console.warn("[lambda] demo transaction upsert skipped", { message: error?.message });
          }
        }

        return {
          mode: "DEMO",
          items: 0,
          fetched: stubTransactions.length,
          upserted,
        };
      });

      return respond(event, 202, {
        status: "ACCEPTED",
        from: fromIso,
        to: toIso,
        ...result,
        traceId,
      });
    } catch (error) {
      const status = error?.statusCode || error?.status || 500;
      return respond(event, status, {
        error: {
          code: "TRANSACTIONS_SYNC_FAILED",
          message: error?.message || "Failed to load demo transactions",
          traceId,
        },
      });
    }
  }

  try {
    const result = await withUserClient(auth.sub, async (client) => {
      await ensureUserRow(client, auth);
      const tokenColumn = await resolvePlaidTokenColumn(client);
      const selectSql = `
        SELECT item_id, ${tokenColumn} AS encrypted_token
        FROM plaid_items
        WHERE user_id = current_setting('appsec.user_id', true)::uuid`;
      const { rows: items } = await client.query(selectSql);
      if (!items || items.length === 0) {
        return { items: 0, fetched: 0, upserted: 0 };
      }

      let fetched = 0;
      let upserted = 0;

      for (const item of items) {
        const decryptedToken = await decryptSecret(item.encrypted_token);
        if (!decryptedToken) {
          console.warn("[lambda] plaid item missing decryptable token", { itemId: item.item_id });
          continue;
        }

        let offset = 0;
        let total = 0;
        const collectedTransactions = [];
        let accountsPayload = [];
        const itemIdentifier = item.item_id || "unknown";

        do {
          const response = await plaidFetch("/transactions/get", {
            access_token: decryptedToken,
            start_date: fromIso,
            end_date: toIso,
            options: {
              include_personal_finance_category: true,
              count: 250,
              offset,
            },
          });
          if (offset === 0 && Array.isArray(response.accounts)) {
            accountsPayload = response.accounts;
          }
          const batch = Array.isArray(response.transactions) ? response.transactions : [];
          collectedTransactions.push(...batch);
          const batchCount = batch.length;
          offset += batchCount;
          total =
            typeof response.total_transactions === "number" && response.total_transactions > 0
              ? response.total_transactions
              : offset;
          if (batchCount === 0) {
            break;
          }
        } while (offset < total);

        fetched += collectedTransactions.length;

        const accountMap = new Map();
        const merchantCache = new Map();

        if (Array.isArray(accountsPayload)) {
          for (const account of accountsPayload) {
            if (!account || !account.account_id) continue;
            const accountUuid = hashToUuid(`acct:${itemIdentifier}:${account.account_id}`);
            const accountName =
              (account.official_name && account.official_name.trim().length > 0
                ? account.official_name
                : account.name) || "Plaid Account";
            const institution =
              (account.subtype && account.subtype.trim().length > 0 ? `Plaid ${account.subtype}` : null) ||
              (account.type && account.type.trim().length > 0 ? `Plaid ${account.type}` : "Plaid");
            await upsertAccount(client, accountUuid, accountName, institution);
            accountMap.set(account.account_id, accountUuid);
          }
        }

        for (const transaction of collectedTransactions) {
          const merchantNameCandidate =
            (transaction.merchant_name && transaction.merchant_name.trim().length > 0
              ? transaction.merchant_name
              : null) ||
            (transaction.personal_finance_category &&
            transaction.personal_finance_category.primary &&
            transaction.personal_finance_category.primary.trim().length > 0
              ? transaction.personal_finance_category.primary
              : null) ||
            (transaction.name && transaction.name.trim().length > 0 ? transaction.name : null) ||
            "Unknown Merchant";

          let merchantId = merchantCache.get(merchantNameCandidate);
      if (!merchantId) {
        const merchantUuid = hashToUuid(`merchant:${merchantNameCandidate}`);
        try {
          const merchantResult = await withSavepoint(client, "merchant", () =>
            client.query(
              `INSERT INTO merchants (id, name)
                   VALUES ($1, $2)
                   ON CONFLICT (id)
                   DO UPDATE SET name = EXCLUDED.name
                   RETURNING id`,
              [merchantUuid, merchantNameCandidate],
            ),
          );
          merchantId = merchantResult.rows[0]?.id || merchantUuid;
        } catch (error) {
              console.warn("[lambda] merchant upsert fallback", { message: error?.message });
              const fallback = await client.query(`SELECT id FROM merchants WHERE name = $1 LIMIT 1`, [
                merchantNameCandidate,
              ]);
              if (fallback.rows[0]?.id) {
                merchantId = fallback.rows[0].id;
              } else {
                const inserted = await client.query(
                  `INSERT INTO merchants (id, name)
                   VALUES ($1, $2)
                   ON CONFLICT DO NOTHING
                   RETURNING id`,
                  [merchantUuid, merchantNameCandidate],
                );
                merchantId = inserted.rows[0]?.id || merchantUuid;
              }
            }
            merchantCache.set(merchantNameCandidate, merchantId);
          }

          const plaidAccountId = transaction.account_id || "unknown";
          let accountId = accountMap.get(plaidAccountId);
          if (!accountId) {
            accountId = hashToUuid(`acct:${itemIdentifier}:${plaidAccountId}`);
            accountMap.set(plaidAccountId, accountId);
            await upsertAccount(client, accountId, "Plaid Account", "Plaid");
          }

          const occurredAtIso = transaction.date
            ? new Date(`${transaction.date}T00:00:00Z`).toISOString()
            : new Date().toISOString();
          const authorizedAtIso = transaction.authorized_date
            ? new Date(`${transaction.authorized_date}T00:00:00Z`).toISOString()
            : null;
          const rawAmount = Number(transaction.amount || 0);
          let amount = Number.isFinite(rawAmount) ? rawAmount : 0;
          amount = amount >= 0 ? -Math.abs(amount) : Math.abs(amount);
          const currency = (transaction.iso_currency_code || transaction.unofficial_currency_code || "USD").toUpperCase();
          const pending = Boolean(transaction.pending);
          const category =
            (Array.isArray(transaction.category) && transaction.category.length > 0
              ? transaction.category[0]
              : null) ||
            (transaction.personal_finance_category &&
            transaction.personal_finance_category.detailed &&
            transaction.personal_finance_category.detailed.trim().length > 0
              ? transaction.personal_finance_category.detailed
              : null) ||
            "Uncategorized";
          const description =
            (transaction.name && transaction.name.trim().length > 0 ? transaction.name : null) ||
            (transaction.merchant_name && transaction.merchant_name.trim().length > 0 ? transaction.merchant_name : null) ||
            "Plaid transaction";
          const transactionUuid = hashToUuid(`tx:${itemIdentifier}:${transaction.transaction_id || crypto.randomUUID()}`);

          try {
            await withSavepoint(client, "txn", () =>
              client.query(
                `INSERT INTO transactions
                   (id, user_id, account_id, merchant_id, amount, currency, occurred_at, authorized_at, pending, category, description)
                 VALUES
                   ($1, current_setting('appsec.user_id', true)::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (id)
                 DO UPDATE SET
                   account_id = EXCLUDED.account_id,
                   merchant_id = EXCLUDED.merchant_id,
                   amount = EXCLUDED.amount,
                   currency = EXCLUDED.currency,
                   occurred_at = EXCLUDED.occurred_at,
                   authorized_at = EXCLUDED.authorized_at,
                   pending = EXCLUDED.pending,
                   category = EXCLUDED.category,
                   description = EXCLUDED.description`,
                [
                  transactionUuid,
                  accountId,
                  merchantId,
                  amount,
                  currency,
                  occurredAtIso,
                  authorizedAtIso,
                  pending,
                  category,
                  description,
                ],
              ),
            );
            upserted += 1;
          } catch (error) {
            console.warn("[lambda] transaction upsert skipped", { message: error?.message, transactionId: transactionUuid });
          }
        }
      }

      return { items: items.length, fetched, upserted };
    });

    return respond(event, 202, {
      status: "ACCEPTED",
      from: fromIso,
      to: toIso,
      ...result,
      traceId,
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "TRANSACTIONS_SYNC_FAILED",
        message: error?.message || "Failed to sync transactions",
        traceId,
      },
    });
  }
}

async function handleTransactionsReset(event) {
  const auth = await authenticate(event);
  let unlinkPlaid = false;
  try {
    const body = parseJsonBody(event);
    unlinkPlaid = Boolean(body?.unlinkPlaid);
  } catch {
    unlinkPlaid = false;
  }
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  try {
    await withUserClient(auth.sub, async (client) => {
      await client.query(
        `DELETE FROM transactions WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
      );
      await client.query(
        `DELETE FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
      );
      if (unlinkPlaid) {
        await client.query(
          `DELETE FROM plaid_items WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );
      }
    });
    return respond(event, 202, {
      status: "ACCEPTED",
      traceId,
    });
  } catch (error) {
    return respond(event, error?.statusCode || error?.status || 500, {
      error: {
        code: "TRANSACTIONS_RESET_FAILED",
        message: error?.message || "Failed to reset transactions",
        traceId,
      },
    });
  }
}

async function handleDevAuthLogin(event) {
  if (!DEV_LOGIN_ENABLED) {
    return respond(event, 403, {
      error: {
        code: "FORBIDDEN",
        message: "Dev login is disabled. Set ENABLE_DEV_LOGIN=true to permit demo access.",
      },
    });
  }
  if (!DEV_JWT_SECRET || DEV_JWT_SECRET.length < 32) {
    return respond(event, 500, {
      error: {
        code: "INVALID_DEV_SECRET",
        message: "SAFEPOCKET_DEV_JWT_SECRET must be at least 32 characters.",
      },
    });
  }
  let userId = DEV_USER_ID;
  try {
    const body = parseJsonBody(event);
    if (body?.userId && typeof body.userId === "string" && body.userId.length > 0) {
      userId = body.userId;
    }
  } catch {
    // use default
  }
  const { SignJWT } = await loadJoseRuntime();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresInSeconds = 60 * 60; // 1 hour
  const token = await new SignJWT({ sub: userId, scope: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("safepocket-dev")
    .setAudience("safepocket-web")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + expiresInSeconds)
    .sign(new TextEncoder().encode(DEV_JWT_SECRET));
  return respond(event, 200, {
    token,
    expiresInSeconds,
    userId,
  });
}

async function handleDevAuthLogout(event) {
  const auth = await authenticate(event);
  const userId = auth.sub;
  
  // Only allow cleanup for demo user
  if (userId !== DEV_USER_ID) {
    return respond(event, 200, { ok: true, message: "Non-demo user, no cleanup needed" });
  }

  try {
    await withUserClient(userId, async (client) => {
      // Delete all transactions for the demo user
      await client.query(
        `DELETE FROM transactions
         WHERE user_id = current_setting('appsec.user_id', true)::uuid
            OR account_id IN (
              SELECT id FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid
            )`,
      );
      // Delete all accounts for the demo user
      await client.query(
        `DELETE FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
      );
      // Delete chat messages if any
      try {
        await client.query(
          `DELETE FROM chat_messages WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );
      } catch {
        // Table may not exist
      }
    });
    return respond(event, 200, { ok: true, message: "Demo user data cleared" });
  } catch (error) {
    console.error("[dev/auth/logout] cleanup error", error);
    return respond(event, 200, { ok: true, message: "Cleanup attempted", error: error?.message });
  }
}

exports.handler = async (event) => {
  try {
    const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") {
      return respond(event, 204, "");
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
    if (method === "POST" && path === "/dev/auth/login") {
      return await handleDevAuthLogin(event);
    }
    if (method === "POST" && path === "/dev/auth/logout") {
      return await handleDevAuthLogout(event);
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
    if (path === "/diagnostics/auth") {
      return await handleDiagnosticsAuth(event);
    }
    if (path === "/diagnostics/db/plaid-items") {
      const payload = await authenticate(event);
      const res = await withUserClient(payload.sub, (c) => checkPlaidItems(c));
      return respond(event, 200, res);
    }
    if (method === "GET" && path === "/diagnostics/plaid-config") {
      return await handleDiagnosticsPlaidConfig(event);
    }
    if (method === "POST" && path === "/diagnostics/db/maint") {
      return await handleDiagnosticsDbMaintenance(event);
    }

    if (method === "POST" && path === "/admin/db/plaid-items/ensure-constraints") {
      const adminHdr = event.headers?.["x-admin"] || event.headers?.["X-Admin"];
      if (!ADMIN_SQL_TOKEN || adminHdr !== ADMIN_SQL_TOKEN) {
        return respond(event, 403, { error: "forbidden" });
      }
      const res = await withUserClient(ANON_USER_ID, (c) => ensurePlaidItemsConstraints(c));
      return respond(event, 200, res);
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
