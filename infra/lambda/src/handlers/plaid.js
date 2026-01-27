"use strict";

const crypto = require("crypto");
const { authenticate } = require("../services/auth");
const { createLinkToken, exchangePublicToken, getTransactions } = require("../services/plaid");
const { encryptSecret, decryptSecret } = require("../utils/encryption");
const {
  ensureUserRow,
  resolvePlaidTokenColumn,
  upsertAccount,
  upsertMerchant,
  upsertTransaction,
} = require("../services/transactions");
const { buildStubTransactions, buildStubAccounts } = require("../services/demo");
const { respond } = require("../utils/response");
const {
  parseJsonBody,
  parseRange,
  toIsoDate,
  coerceBoolean,
  parseMonth,
  hashToUuid,
  isAuthOptional,
} = require("../utils/helpers");
const { withUserClient } = require("../db/pool");
const { DAY_MS, ANON_USER_ID } = require("../utils/constants");

/**
 * Handle POST /plaid/link-token
 */
async function handlePlaidLinkToken(event) {
  const payload = isAuthOptional() ? { sub: ANON_USER_ID } : await authenticate(event);
  
  try {
    const result = await createLinkToken(payload.sub);
    return respond(event, 200, result);
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

/**
 * Handle POST /plaid/exchange
 */
async function handlePlaidExchange(event) {
  const auth = await authenticate(event);
  const wantSync = String(event.queryStringParameters?.sync || "").trim() === "1";
  const body = parseJsonBody(event);
  const publicToken = body.publicToken || body.public_token;
  
  if (!publicToken || typeof publicToken !== "string") {
    return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "publicToken is required" } });
  }
  
  try {
    const { accessToken, itemId, requestId } = await exchangePublicToken(publicToken);
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
      const syncEvent = { ...event, body: JSON.stringify({}), httpMethod: "POST" };
      return await handleTransactionsSync(syncEvent);
    }
    
    return respond(event, 200, { itemId, status: "SUCCESS", requestId });
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

/**
 * Handle POST /transactions/sync
 */
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

  // Demo seed mode
  if (demoSeed) {
    try {
      const result = await withUserClient(auth.sub, async (client) => {
        await ensureUserRow(client, auth);
        
        // Clear existing data
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
        const stubAccounts = buildStubAccounts(auth.sub);
        
        // Add extra demo transactions
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

        // Build account map
        const accountIterator = stubAccounts[Symbol.iterator]();
        const accountMap = new Map();
        for (const tx of stubTransactions) {
          if (!accountMap.has(tx.accountId)) {
            const template = accountIterator.next().value || {
              name: "Demo Checking",
              institution: "Safepocket Demo Bank",
              createdAt: new Date().toISOString(),
            };
            accountMap.set(tx.accountId, template);
          }
        }

        // Upsert accounts
        for (const [accountId, template] of accountMap.entries()) {
          await upsertAccount(client, accountId, template.name, template.institution);
        }

        // Upsert transactions
        const merchantCache = new Map();
        let upserted = 0;
        for (const tx of stubTransactions) {
          const merchantName = tx.merchantName || "Demo Merchant";
          const merchantId = await upsertMerchant(client, merchantCache, merchantName);
          try {
            await upsertTransaction(client, tx, merchantId);
            upserted += 1;
          } catch (error) {
            console.warn("[lambda] demo transaction upsert skipped", { message: error?.message });
          }
        }

        return { mode: "DEMO", items: 0, fetched: stubTransactions.length, upserted };
      });

      return respond(event, 202, { status: "ACCEPTED", from: fromIso, to: toIso, ...result, traceId });
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

  // Real Plaid sync mode
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

        // Fetch all transactions with pagination
        let offset = 0;
        let total = 0;
        const collectedTransactions = [];
        let accountsPayload = [];
        const itemIdentifier = item.item_id || "unknown";

        do {
          const response = await getTransactions(decryptedToken, fromIso, toIso, { count: 250, offset });
          if (offset === 0) accountsPayload = response.accounts;
          collectedTransactions.push(...response.transactions);
          const batchCount = response.transactions.length;
          offset += batchCount;
          total = response.totalTransactions > 0 ? response.totalTransactions : offset;
          if (batchCount === 0) break;
        } while (offset < total);

        fetched += collectedTransactions.length;

        // Process accounts
        const accountMap = new Map();
        const merchantCache = new Map();
        
        for (const account of accountsPayload) {
          if (!account?.account_id) continue;
          const accountUuid = hashToUuid(`acct:${itemIdentifier}:${account.account_id}`);
          const accountName = (account.official_name?.trim() || account.name) || "Plaid Account";
          const institution = (account.subtype?.trim() ? `Plaid ${account.subtype}` : null) ||
            (account.type?.trim() ? `Plaid ${account.type}` : "Plaid");
          await upsertAccount(client, accountUuid, accountName, institution);
          accountMap.set(account.account_id, accountUuid);
        }

        // Process transactions
        for (const transaction of collectedTransactions) {
          const merchantNameCandidate =
            transaction.merchant_name?.trim() ||
            transaction.personal_finance_category?.primary?.trim() ||
            transaction.name?.trim() ||
            "Unknown Merchant";

          const merchantId = await upsertMerchant(client, merchantCache, merchantNameCandidate);

          const plaidAccountId = transaction.account_id || "unknown";
          let accountId = accountMap.get(plaidAccountId);
          if (!accountId) {
            accountId = hashToUuid(`acct:${itemIdentifier}:${plaidAccountId}`);
            accountMap.set(plaidAccountId, accountId);
            await upsertAccount(client, accountId, "Plaid Account", "Plaid");
          }

          const rawAmount = Number(transaction.amount || 0);
          let amount = Number.isFinite(rawAmount) ? rawAmount : 0;
          amount = amount >= 0 ? -Math.abs(amount) : Math.abs(amount);
          
          const category = (transaction.category?.[0]) ||
            transaction.personal_finance_category?.detailed?.trim() ||
            "Uncategorized";
          const description = transaction.name?.trim() || transaction.merchant_name?.trim() || "Plaid transaction";
          const transactionUuid = hashToUuid(`tx:${itemIdentifier}:${transaction.transaction_id || crypto.randomUUID()}`);

          try {
            await upsertTransaction(client, {
              id: transactionUuid,
              accountId,
              merchantName: merchantNameCandidate,
              amount,
              currency: (transaction.iso_currency_code || transaction.unofficial_currency_code || "USD").toUpperCase(),
              occurredAt: transaction.date ? new Date(`${transaction.date}T00:00:00Z`).toISOString() : new Date().toISOString(),
              authorizedAt: transaction.authorized_date ? new Date(`${transaction.authorized_date}T00:00:00Z`).toISOString() : null,
              pending: Boolean(transaction.pending),
              category,
              description,
            }, merchantId);
            upserted += 1;
          } catch (error) {
            console.warn("[lambda] transaction upsert skipped", { message: error?.message, transactionId: transactionUuid });
          }
        }
      }

      return { items: items.length, fetched, upserted };
    });

    return respond(event, 202, { status: "ACCEPTED", from: fromIso, to: toIso, ...result, traceId });
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

/**
 * Handle POST /transactions/reset
 */
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
    return respond(event, 202, { status: "ACCEPTED", traceId });
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

/**
 * Handle GET /diagnostics/plaid-config
 */
async function handleDiagnosticsPlaidConfig(event) {
  const { loadConfig } = require("../config/loader");
  const { parseList } = require("../utils/helpers");
  
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

module.exports = {
  handlePlaidLinkToken,
  handlePlaidExchange,
  handleTransactionsSync,
  handleTransactionsReset,
  handleDiagnosticsPlaidConfig,
};
