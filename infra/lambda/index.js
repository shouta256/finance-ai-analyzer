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
const ENABLE_STUBS = (process.env.SAFEPOCKET_ENABLE_STUBS || "false").toLowerCase() === "true";

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
    const normalisedIssuer = cognitoIssuer ? stripTrailingSlash(ensureHttps(cognitoIssuer)) : undefined;
    const normalisedDomain = cognitoDomain ? stripTrailingSlash(ensureHttps(cognitoDomain)) : undefined;
    const cognitoJwksUrl =
      process.env.COGNITO_JWKS_URL ||
      cognitoSecret?.jwksUrl ||
      (normalisedIssuer ? `${normalisedIssuer}/.well-known/jwks.json` : undefined) ||
      (normalisedDomain ? `${normalisedDomain}/.well-known/jwks.json` : undefined);
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
        clientSecret: cognitoClientSecret,
        redirectUri: cognitoRedirectUri,
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
  const audiences = normalizeAudienceList(cognito?.audienceList);
  if (audiences.length > 0) {
    return audiences;
  }
  if (cognito?.clientId) {
    return [cognito.clientId];
  }
  return [];
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
      const insertSql = `
        INSERT INTO plaid_items (user_id, item_id, ${tokenColumn}, linked_at)
        VALUES (current_setting('appsec.user_id', true)::uuid, $1, $2, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET item_id = EXCLUDED.item_id, ${tokenColumn} = EXCLUDED.${tokenColumn}, linked_at = NOW()`;
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
  const cookieAttributes = "Path=/; SameSite=None; Secure";
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
          `DELETE FROM transactions WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );
        await client.query(
          `DELETE FROM accounts WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );

        const stubTransactions = buildStubTransactions(auth.sub, syncStart, now);
        const alternateAccountId = crypto.randomUUID();
        const baseTime = syncStart.getTime();
        stubTransactions.push(
          {
            id: hashToUuid(`demo:rent:${fromIso}`),
            userId: auth.sub,
            accountId: alternateAccountId,
            merchantName: "City Apartments",
            amount: -1450.0,
            currency: "USD",
            occurredAt: new Date(baseTime + 4 * DAY_MS).toISOString(),
            authorizedAt: new Date(baseTime + 4 * DAY_MS + 90 * 60 * 1000).toISOString(),
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
            occurredAt: new Date(baseTime + 10 * DAY_MS).toISOString(),
            authorizedAt: new Date(baseTime + 10 * DAY_MS).toISOString(),
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
    if (method === "GET" && path === "/diagnostics/auth") {
      return await handleDiagnosticsAuth(event);
    }
    if (method === "GET" && path === "/diagnostics/plaid-config") {
      return await handleDiagnosticsPlaidConfig(event);
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
