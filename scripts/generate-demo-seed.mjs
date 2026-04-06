#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profilePath = path.resolve(__dirname, "../shared/demo/demo-profile.json");

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

function hashToUuid(value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function deterministicAccountId(userId, accountKey) {
  return hashToUuid(`demo:account:${userId}:${accountKey}`);
}

function clampDay(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.max(1, Math.min(day, lastDay));
}

function buildTransactions(userId) {
  const now = new Date();
  const todayDate = now.getUTCDate();
  const currentYear = now.getUTCFullYear();
  const currentMonthIndex = now.getUTCMonth();
  const transactions = [];

  for (const template of profile.transactions || []) {
    const monthOffsets = Array.isArray(template.monthOffsets) ? template.monthOffsets : [];
    const days = Array.isArray(template.days) ? template.days : [];
    const accountId = deterministicAccountId(userId, template.accountKey);

    for (const offsetValue of monthOffsets) {
      const monthOffset = Number.isFinite(offsetValue) ? Math.max(0, offsetValue) : 0;
      const anchor = new Date(Date.UTC(currentYear, currentMonthIndex - monthOffset, 1));
      const year = anchor.getUTCFullYear();
      const monthIndex = anchor.getUTCMonth();

      for (const dayValue of days) {
        if (!Number.isFinite(dayValue)) continue;
        const day = clampDay(year, monthIndex, dayValue);
        if (monthOffset === 0 && day > todayDate) {
          continue;
        }
        const occurredAt = new Date(Date.UTC(year, monthIndex, day, 0, 0, 0, 0));
        const authorizedAt = new Date(occurredAt.getTime() - 30 * 60 * 1000);
        transactions.push({
          id: hashToUuid(`demo:tx:${userId}:${template.key}:${occurredAt.toISOString()}`),
          userId,
          accountId,
          merchantName: template.merchantName,
          amount: Number(template.amount || 0).toFixed(2),
          currency: "USD",
          occurredAt: occurredAt.toISOString(),
          authorizedAt: authorizedAt.toISOString(),
          category: template.category,
          description: template.description,
          pending: Boolean(template.pendingCurrentMonth) && monthOffset === 0,
        });
      }
    }
  }

  return transactions.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function buildAccounts(userId) {
  return (profile.accounts || []).map((account) => ({
    id: deterministicAccountId(userId, account.key),
    userId,
    name: account.name,
    institution: account.institution,
  }));
}

function merchantsFromTransactions(transactions) {
  return Array.from(new Set(transactions.map((tx) => tx.merchantName))).sort();
}

const user = profile.user;
const accounts = buildAccounts(user.id);
const transactions = buildTransactions(user.id);
const merchants = merchantsFromTransactions(transactions).map((name) => ({
  id: hashToUuid(`demo:merchant:${name.toLowerCase()}`),
  name,
}));

const lines = [];
lines.push("-- Generated from shared/demo/demo-profile.json");
lines.push("BEGIN;");
lines.push(`INSERT INTO users (id, email, full_name) VALUES (${sqlString(user.id)}, ${sqlString(user.email)}, ${sqlString(user.fullName)}) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name;`);
lines.push(`DELETE FROM chat_messages WHERE user_id = ${sqlString(user.id)};`);
lines.push(`DELETE FROM plaid_items WHERE user_id = ${sqlString(user.id)};`);
lines.push(`DELETE FROM transactions WHERE user_id = ${sqlString(user.id)};`);
lines.push(`DELETE FROM accounts WHERE user_id = ${sqlString(user.id)};`);

for (const account of accounts) {
  lines.push(
    `INSERT INTO accounts (id, user_id, name, institution) VALUES (${sqlString(account.id)}, ${sqlString(account.userId)}, ${sqlString(account.name)}, ${sqlString(account.institution)}) ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name, institution = EXCLUDED.institution;`,
  );
}

for (const merchant of merchants) {
  lines.push(
    `INSERT INTO merchants (id, name) VALUES (${sqlString(merchant.id)}, ${sqlString(merchant.name)}) ON CONFLICT (name) DO NOTHING;`,
  );
}

for (const tx of transactions) {
  lines.push(
    `INSERT INTO transactions (id, user_id, account_id, merchant_id, amount, currency, occurred_at, authorized_at, category, description, pending) VALUES (${sqlString(tx.id)}, ${sqlString(tx.userId)}, ${sqlString(tx.accountId)}, (SELECT id FROM merchants WHERE name = ${sqlString(tx.merchantName)}), ${tx.amount}, ${sqlString(tx.currency)}, ${sqlString(tx.occurredAt)}, ${sqlString(tx.authorizedAt)}, ${sqlString(tx.category)}, ${sqlString(tx.description)}, ${tx.pending ? "true" : "false"}) ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, account_id = EXCLUDED.account_id, merchant_id = EXCLUDED.merchant_id, amount = EXCLUDED.amount, currency = EXCLUDED.currency, occurred_at = EXCLUDED.occurred_at, authorized_at = EXCLUDED.authorized_at, category = EXCLUDED.category, description = EXCLUDED.description, pending = EXCLUDED.pending;`,
  );
}

lines.push("COMMIT;");

process.stdout.write(`${lines.join("\n")}\n`);
