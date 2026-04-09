const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../services/auth") {
    return { authenticate: async () => ({ sub: "test-user" }) };
  }
  if (request === "../services/ai") {
    return { callAiAssistant: async () => null };
  }
  if (request === "../services/analytics") {
    return { summarise: () => null };
  }
  if (request === "../services/transactions") {
    return {
      queryTransactionsWithClient: async () => [],
      ensureUserRow: async () => {},
    };
  }
  if (request === "../utils/response") {
    return { respond: (_event, status, body) => ({ status, body }) };
  }
  if (request === "../utils/helpers") {
    return {
      parseJsonBody: (event) => JSON.parse(event.body || "{}"),
      truncateText: (text) => text,
    };
  }
  if (request === "../db/pool") {
    return { withUserClient: async (_userId, fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }) };
  }
  if (request === "../utils/constants") {
    return {
      UUID_REGEX: /^[0-9a-f-]{36}$/i,
      DEV_USER_ID: "demo-user",
      CHAT_MAX_HISTORY_MESSAGES: 3,
      CHAT_HISTORY_CHAR_LIMIT: 1200,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { __test__ } = require("./chat");
Module._load = originalLoad;

test("classifyIntent treats natural spend lookup phrasing as transaction lookup", () => {
  assert.equal(__test__.classifyIntent("how did i spend on coffee"), "TRANSACTION_LOOKUP");
});

test("transaction lookup fallback summarizes matching references instead of monthly summary", () => {
  const reply = __test__.buildFallbackReply({
    intent: "TRANSACTION_LOOKUP",
    retrievedReferences: [
      {
        merchant: "Starbucks",
        occurredOn: "2026-04-01",
        amountCents: -875,
      },
      {
        merchant: "Blue Bottle Coffee",
        occurredOn: "2026-04-06",
        amountCents: -1250,
      },
    ],
    summary: {
      totals: { income: 99999, expense: -99999, net: 0 },
    },
  });

  assert.match(reply, /You spent a total of \$21\.25/i);
  assert.match(reply, /Starbucks/);
  assert.match(reply, /Blue Bottle Coffee/);
  assert.doesNotMatch(reply, /Top merchant/i);
});
