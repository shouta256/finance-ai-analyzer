"use strict";

const crypto = require("crypto");
const { authenticate, loadJoseRuntime, parseCookies } = require("../services/auth");
const { loadConfig } = require("../config/loader");
const { respond, pickPreferredRedirectOrigin } = require("../utils/response");
const { parseJsonBody, createHttpError } = require("../utils/helpers");
const { withUserClient } = require("../db/pool");
const { ensureUserRow } = require("../services/transactions");
const {
  DEV_JWT_SECRET,
  DEV_LOGIN_ENABLED,
  DEV_USER_ID,
  NORMALISED_ALLOWED_ORIGINS,
  normaliseOriginUrl,
} = require("../utils/constants");

/**
 * Resolve post-auth redirect URL
 */
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

/**
 * Handle POST /auth/token
 */
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
  if (!usingNativeClient && cognito.clientSecret?.trim()) {
    headers.Authorization = `Basic ${Buffer.from(`${clientIdToUse}:${cognito.clientSecret}`).toString("base64")}`;
  }

  const tokenUrl = `${cognito.domain}/oauth2/token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  
  const text = await resp.text();
  if (!resp.ok) {
    console.error("[lambda] Cognito token exchange failed", { status: resp.status, body: text });
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

/**
 * Handle GET /auth/callback
 */
async function handleAuthCallback(event) {
  const query = event.queryStringParameters || {};
  const code = query.code;
  
  if (!code) {
    throw createHttpError(400, "Authorization code missing from query string");
  }

  const wantsJson =
    (query.response?.toLowerCase() === "json") ||
    (query.format?.toLowerCase() === "json") ||
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
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  const text = await resp.text();
  let tokenData = {};
  if (text) {
    try { tokenData = JSON.parse(text); } catch { /* ignore */ }
  }

  if (!resp.ok) {
    console.error("[lambda] Cognito token exchange failed on callback", { status: resp.status, body: tokenData });
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
    } catch { /* ignore */ }
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
    headers: { Location: redirectLocation },
    cookies,
  });
}

/**
 * Handle POST /dev/auth/login (demo login)
 */
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
  } catch { /* use default */ }
  
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
    
  return respond(event, 200, { token, expiresInSeconds, userId });
}

/**
 * Handle POST /dev/auth/logout (demo logout cleanup)
 */
async function handleDevAuthLogout(event) {
  const auth = await authenticate(event);
  const userId = auth.sub;
  
  if (userId !== DEV_USER_ID) {
    return respond(event, 200, { ok: true, message: "Non-demo user, no cleanup needed" });
  }

  try {
    await withUserClient(userId, async (client) => {
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
      try {
        await client.query(
          `DELETE FROM chat_messages WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
        );
      } catch { /* Table may not exist */ }
    });
    return respond(event, 200, { ok: true, message: "Demo user data cleared" });
  } catch (error) {
    console.error("[dev/auth/logout] cleanup error", error);
    return respond(event, 200, { ok: true, message: "Cleanup attempted", error: error?.message });
  }
}

/**
 * Handle GET /diagnostics/auth
 */
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

module.exports = {
  handleAuthToken,
  handleAuthCallback,
  handleDevAuthLogin,
  handleDevAuthLogout,
  handleDiagnosticsAuth,
};
