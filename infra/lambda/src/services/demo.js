"use strict";

const fs = require("fs");
const path = require("path");
const { hashToUuid } = require("../utils/helpers");

let cachedProfile;

function loadProfile() {
  if (cachedProfile) {
    return cachedProfile;
  }
  const candidates = [
    path.resolve(__dirname, "../../shared/demo/demo-profile.json"),
    path.resolve(__dirname, "../../../../shared/demo/demo-profile.json"),
  ];
  const profilePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!profilePath) {
    throw new Error("Shared demo profile is missing");
  }
  cachedProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  return cachedProfile;
}

function clampDay(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.max(1, Math.min(day, lastDay));
}

function deterministicAccountId(userId, accountKey) {
  return hashToUuid(`demo:account:${userId}:${accountKey}`);
}

function buildStubTransactions(userId) {
  const profile = loadProfile();
  const now = new Date();
  const todayDate = now.getUTCDate();
  const currentYear = now.getUTCFullYear();
  const currentMonthIndex = now.getUTCMonth();
  const transactions = [];

  for (const template of profile.transactions || []) {
    const accountId = deterministicAccountId(userId, template.accountKey);
    const monthOffsets = Array.isArray(template.monthOffsets) ? template.monthOffsets : [];
    const days = Array.isArray(template.days) ? template.days : [];

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
          amount: Number(template.amount || 0),
          currency: "USD",
          occurredAt: occurredAt.toISOString(),
          authorizedAt: authorizedAt.toISOString(),
          pending: Boolean(template.pendingCurrentMonth) && monthOffset === 0,
          category: template.category,
          description: template.description,
          notes: null,
          anomalyScore: null,
        });
      }
    }
  }

  return transactions.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function buildStubAccounts(userId) {
  const profile = loadProfile();
  const now = new Date().toISOString();
  return (profile.accounts || []).map((account) => ({
    id: deterministicAccountId(userId, account.key),
    name: account.name,
    institution: account.institution,
    balance: Number(account.balance || 0),
    currency: account.currency || "USD",
    createdAt: now,
  }));
}

function generateDemoTransactions(startDate, endDate, userId) {
  return buildStubTransactions(userId).filter((tx) => {
    const occurredAt = tx?.occurredAt ? new Date(tx.occurredAt) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) return false;
    return occurredAt >= startDate && occurredAt < endDate;
  });
}

function generateDemoAccounts(userId) {
  return buildStubAccounts(userId);
}

module.exports = {
  buildStubTransactions,
  buildStubAccounts,
  generateDemoTransactions,
  generateDemoAccounts,
};
