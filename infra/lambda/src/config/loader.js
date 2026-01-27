"use strict";

const AWS = require("aws-sdk");
const secretsManager = new AWS.SecretsManager();

const { stripTrailingSlash, ensureHttps } = require("../utils/helpers");

// Secret names
function resolveSecretName(value, fallback) {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

const SECRET_COGNITO = resolveSecretName(process.env.SECRET_COGNITO_NAME, "/safepocket/cognito");
const SECRET_PLAID = resolveSecretName(process.env.SECRET_PLAID_NAME, "/safepocket/plaid");

// Config cache
let configPromise;
let configCacheKey;

/**
 * Fetch secret from AWS Secrets Manager
 */
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

/**
 * Load application configuration from environment and secrets
 */
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

    // Cognito configuration
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

    // Try to fetch OpenID configuration if needed
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

    // Plaid configuration
    const plaidEnv = process.env.PLAID_ENV || plaidSecret?.env || plaidSecret?.environment || "sandbox";
    const normalizeString = (value) => typeof value === "string" ? value.trim() : value;
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
      products: process.env.PLAID_PRODUCTS || plaidSecret?.products || "transactions",
      countryCodes: process.env.PLAID_COUNTRY_CODES || plaidSecret?.countryCodes || "US",
      redirectUri: process.env.PLAID_REDIRECT_URI || plaidSecret?.redirectUri || "",
      webhookUrl: process.env.PLAID_WEBHOOK_URL || plaidSecret?.webhookUrl || "",
      webhookSecret: process.env.PLAID_WEBHOOK_SECRET || plaidSecret?.webhookSecret || "",
      clientName: process.env.PLAID_CLIENT_NAME || plaidSecret?.clientName || "Safepocket",
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
        jwePrivateKey: typeof cognitoJwePrivateKey === "string" && cognitoJwePrivateKey.trim().length > 0 
          ? cognitoJwePrivateKey.trim() 
          : undefined,
      },
      plaid: plaidConfig,
    };
  })();
  
  return configPromise;
}

module.exports = {
  loadConfig,
  fetchSecret,
};
