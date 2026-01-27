"use strict";

const { withUserClient } = require("../db/pool");
const { round, hashToUuid, withSavepoint } = require("../utils/helpers");

// Cache for column checks
let userTableSupportsFullName = null;
let plaidTokenColumnName = null;

/**
 * Map transaction row from DB to API format
 */
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

/**
 * Resolve user profile from auth payload
 */
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

/**
 * Check if users table has full_name column
 */
async function usersTableHasFullName(client) {
  if (userTableSupportsFullName !== null) return userTableSupportsFullName;
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

/**
 * Ensure user row exists in DB
 */
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

/**
 * Resolve Plaid token column name
 */
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

/**
 * Query transactions for a user within date range
 */
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

/**
 * Query transactions for a user
 */
async function queryTransactions(userId, fromDate, toDate) {
  return withUserClient(userId, (client) => queryTransactionsWithClient(client, fromDate, toDate));
}

/**
 * Upsert account record
 */
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

/**
 * Upsert merchant record
 */
async function upsertMerchant(client, merchantCache, merchantName) {
  let merchantId = merchantCache.get(merchantName);
  if (!merchantId) {
    const merchantUuid = hashToUuid(`merchant:${merchantName}`);
    try {
      const merchantResult = await withSavepoint(client, "merchant", () =>
        client.query(
          `INSERT INTO merchants (id, name)
           VALUES ($1, $2)
           ON CONFLICT (id)
           DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [merchantUuid, merchantName],
        ),
      );
      merchantId = merchantResult.rows[0]?.id || merchantUuid;
    } catch (error) {
      console.warn("[lambda] merchant upsert fallback", { message: error?.message });
      const fallback = await client.query(`SELECT id FROM merchants WHERE name = $1 LIMIT 1`, [merchantName]);
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
  return merchantId;
}

/**
 * Upsert transaction record
 */
async function upsertTransaction(client, tx, merchantId) {
  const amount = Number.isFinite(Number(tx.amount)) ? Number(tx.amount) : 0;
  const currency = (tx.currency || "USD").toUpperCase();
  const occurredAtIso = tx.occurredAt || new Date().toISOString();
  const authorizedAtIso = tx.authorizedAt || occurredAtIso;

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
        tx.id,
        tx.accountId,
        merchantId,
        amount,
        currency,
        occurredAtIso,
        authorizedAtIso,
        Boolean(tx.pending),
        tx.category || "General",
        tx.description || tx.merchantName,
      ],
    ),
  );
}

/**
 * Query accounts for a user
 */
async function queryAccountsWithClient(client) {
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
}

/**
 * Update transaction category
 */
async function updateTransactionCategory(client, transactionId, category) {
  const res = await client.query(
    `UPDATE transactions
     SET category = $1
     WHERE id = $2
       AND user_id = current_setting('appsec.user_id', true)::uuid
     RETURNING id, category`,
    [category, transactionId],
  );
  if (res.rowCount === 0) return null;
  return { id: res.rows[0].id, category: res.rows[0].category };
}

/**
 * Sync transactions from Plaid (stub - actual implementation needs Plaid service)
 */
async function syncFromPlaid(client, userId) {
  // This is a placeholder - actual implementation would:
  // 1. Get Plaid items for user
  // 2. Call Plaid sync endpoint
  // 3. Upsert accounts and transactions
  console.warn("[transactions] syncFromPlaid called but not fully implemented in modular version");
  return { synced: 0, status: "NOT_IMPLEMENTED" };
}

module.exports = {
  mapTransactionRow,
  resolveUserProfile,
  usersTableHasFullName,
  ensureUserRow,
  resolvePlaidTokenColumn,
  queryTransactionsWithClient,
  queryTransactions,
  queryAccountsWithClient,
  updateTransactionCategory,
  upsertAccount,
  upsertMerchant,
  upsertTransaction,
  syncFromPlaid,
};
