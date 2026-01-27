"use strict";

const crypto = require("crypto");
const { loadConfig } = require("../config/loader");
const { createHttpError, parseList } = require("../utils/helpers");
const { PLAID_TIMEOUT_MS } = require("../utils/constants");

/**
 * Make a request to Plaid API
 */
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

/**
 * Create Plaid link token for user
 */
async function createLinkToken(userId) {
  const { plaid } = await loadConfig();
  const products = parseList(plaid.products, ["transactions"]);
  const countryCodes = parseList(plaid.countryCodes, ["US"]);
  
  const clientUserId = typeof userId === "string" && userId.trim().length > 0
    ? userId.replace(/-/g, "").slice(0, 24)
    : crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    
  const response = await plaidFetch("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: plaid.clientName || "Safepocket",
    language: "en",
    products,
    country_codes: countryCodes,
    redirect_uri: plaid.redirectUri || undefined,
    webhook: plaid.webhookUrl || undefined,
  });
  
  return {
    linkToken: response.link_token,
    expiration: response.expiration,
    requestId: response.request_id ?? null,
  };
}

/**
 * Exchange public token for access token
 */
async function exchangePublicToken(publicToken) {
  const exchange = await plaidFetch("/item/public_token/exchange", { public_token: publicToken });
  const accessToken = exchange.access_token;
  const itemId = exchange.item_id;
  
  if (!accessToken || !itemId) {
    throw createHttpError(502, "Plaid exchange response missing access_token or item_id");
  }
  
  return {
    accessToken,
    itemId,
    requestId: exchange.request_id ?? null,
  };
}

/**
 * Get transactions from Plaid
 */
async function getTransactions(accessToken, startDate, endDate, options = {}) {
  const response = await plaidFetch("/transactions/get", {
    access_token: accessToken,
    start_date: startDate,
    end_date: endDate,
    options: {
      include_personal_finance_category: true,
      count: options.count || 250,
      offset: options.offset || 0,
    },
  });
  
  return {
    transactions: response.transactions || [],
    accounts: response.accounts || [],
    totalTransactions: response.total_transactions || 0,
    requestId: response.request_id ?? null,
  };
}

module.exports = {
  plaidFetch,
  createLinkToken,
  exchangePublicToken,
  getTransactions,
};
