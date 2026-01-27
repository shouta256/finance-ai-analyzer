"use strict";

// Plaid handlers (includes sync/reset which use Plaid)
const {
  handlePlaidLinkToken,
  handlePlaidExchange,
  handleTransactionsSync,
  handleTransactionsReset,
  handleDiagnosticsPlaidConfig,
} = require("./plaid");

// Analytics handlers
const { handleAnalyticsSummary } = require("./analytics");

// Auth handlers
const {
  handleAuthToken,
  handleAuthCallback,
  handleDevAuthLogin,
  handleDevAuthLogout,
  handleDiagnosticsAuth,
} = require("./auth");

// Chat handlers
const { handleChat } = require("./chat");

// Transaction handlers (GET/PATCH transactions, GET accounts)
const {
  handleTransactions,
  handleAccounts,
} = require("./transactions");

// Diagnostics handlers
const {
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
} = require("./diagnostics");

module.exports = {
  // Plaid
  handlePlaidLinkToken,
  handlePlaidExchange,
  handleDiagnosticsPlaidConfig,

  // Analytics
  handleAnalyticsSummary,

  // Auth
  handleAuthToken,
  handleAuthCallback,
  handleDevAuthLogin,
  handleDevAuthLogout,
  handleDiagnosticsAuth,

  // Chat
  handleChat,

  // Transactions
  handleTransactions,
  handleTransactionsSync,
  handleTransactionsReset,
  handleAccounts,

  // Diagnostics
  handleDnsDiagnostics,
  handleDiagnosticsDbMaintenance,
  handleDiagnosticsPlaidItems,
  handleAdminEnsureConstraints,
};
