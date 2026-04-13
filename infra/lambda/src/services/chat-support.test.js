const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFallbackReply,
  buildRetrievedSources,
  classifyIntent,
  filterSourcesForReply,
} = require("./chat-support");

test("classifyIntent treats natural spend lookup phrasing as transaction lookup", () => {
  assert.equal(classifyIntent("how did i spend on coffee"), "TRANSACTION_LOOKUP");
});

test("transaction lookup fallback summarizes matching references instead of monthly summary", () => {
  const reply = buildFallbackReply({
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

test("retrieved sources keep merchant and matched-term hits near the top", () => {
  const sources = buildRetrievedSources(
    [
      {
        id: "11111111-1111-1111-1111-111111111111",
        merchantName: "Starbucks",
        occurredAt: "2026-04-01T12:00:00Z",
        amount: -8.75,
        category: "Dining",
        description: "Cold brew coffee",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        merchantName: "Payroll",
        occurredAt: "2026-04-02T12:00:00Z",
        amount: 2500,
        category: "Income",
        description: "Salary",
      },
    ],
    "how much did i spend on coffee",
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].merchant, "Starbucks");
  assert.match(sources[0].reasons.join(" "), /matched terms/i);
});

test("filterSourcesForReply falls back to top transaction sources when reply stays abstract", () => {
  const sources = [
    {
      merchant: "Starbucks",
      occurredOn: "2026-04-01",
      matchedTerms: ["coffee"],
    },
    {
      merchant: "Blue Bottle Coffee",
      occurredOn: "2026-04-06",
      matchedTerms: ["coffee"],
    },
    {
      merchant: "Whole Foods",
      occurredOn: "2026-04-08",
      matchedTerms: ["groceries"],
    },
    {
      merchant: "Rent",
      occurredOn: "2026-04-01",
      matchedTerms: ["rent"],
    },
  ];

  const filtered = filterSourcesForReply(
    "Your spending totaled $40.00.",
    sources,
    "TRANSACTION_LOOKUP",
  );

  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].merchant, "Starbucks");
  assert.equal(filtered[1].merchant, "Blue Bottle Coffee");
});
