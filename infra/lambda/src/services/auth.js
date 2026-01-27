"use strict";

const { createHttpError, isAuthOptional } = require("../utils/helpers");
const { loadConfig } = require("../config/loader");
const { DEV_JWT_SECRET, DEV_LOGIN_ENABLED, ANON_USER_ID } = require("../utils/constants");

// JOSE runtime cache
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

// Caches
const cognitoJwkCache = new Map();
const cognitoJweKeyCache = new Map();

/**
 * Parse cookies from event
 */
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

/**
 * Get cached JWE key for Cognito token decryption
 */
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

/**
 * Decrypt JWE token if needed
 */
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

/**
 * Normalize audience list
 */
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

/**
 * Resolve expected audiences for token validation
 */
function resolveExpectedAudiences(cognito) {
  const collected = new Set(normalizeAudienceList(cognito?.audienceList));
  if (cognito?.clientId) collected.add(cognito.clientId);
  if (cognito?.clientIdWeb) collected.add(cognito.clientIdWeb);
  if (cognito?.clientIdNative) collected.add(cognito.clientIdNative);
  return Array.from(collected).filter(Boolean);
}

/**
 * Get Cognito remote JWK set for token verification
 */
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

/**
 * Verify JWT token (supports both Cognito RS256 and demo HS256)
 */
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
          if (payload.iss === "safepocket-dev") {
            return payload;
          }
        }
      }
    } catch (e) {
      console.debug("[auth] HS256 demo token verification failed, trying Cognito RS256", { error: e?.message });
    }
  }

  // Try Cognito RS256 verification
  const jwkSet = await getCognitoRemoteJwkSet(cognito);
  const audiences = resolveExpectedAudiences(cognito);
  const baseOptions = {};
  if (cognito.issuer) {
    baseOptions.issuer = cognito.issuer;
  }
  baseOptions.algorithms = ["RS256"];
  
  const optionVariants = audiences.length > 0
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
      
      // Validate token_use
      const tokenUse = typeof payload.token_use === "string" && payload.token_use.trim().length > 0
        ? payload.token_use.trim()
        : null;
      if (tokenUse && tokenUse !== "access" && tokenUse !== "id") {
        console.warn("[auth] unexpected token_use", { tokenUse });
      }
      
      // Validate audience
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
  
  // Handle last error
  const handledError = lastError && typeof lastError === "object" && "statusCode" in lastError && typeof lastError.statusCode === "number"
    ? lastError
    : null;
  if (handledError) {
    throw handledError;
  }
  
  const { errors: joseErrors2 } = await loadJoseRuntime();
  if (lastError instanceof joseErrors2.JWSSignatureVerificationFailed) {
    throw createHttpError(401, "Token signature invalid");
  }
  
  // Final fallback verification
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
    const { errors: joseErrors3 } = await loadJoseRuntime();
    if (error instanceof joseErrors3.JWTClaimValidationFailed && error.claim === "iss") {
      throw createHttpError(401, "Issuer mismatch");
    }
    throw createHttpError(401, "Token verification failed");
  }
}

/**
 * Authenticate request from event
 */
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

/**
 * Extract authorization header from event
 */
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

module.exports = {
  authenticate,
  verifyJwt,
  parseCookies,
  loadJoseRuntime,
  extractAuthorizationHeader,
};
