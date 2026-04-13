"use strict";

const GREETING_PHRASES = new Set([
  "hello",
  "hi",
  "hey",
  "good morning",
  "good afternoon",
  "good evening",
  "what can you do",
]);

const FINANCE_KEYWORDS = new Set([
  "account",
  "accounts",
  "amount",
  "balance",
  "budget",
  "cash",
  "category",
  "categories",
  "coffee",
  "dining",
  "drink",
  "drinks",
  "expense",
  "expenses",
  "finance",
  "financial",
  "groceries",
  "income",
  "merchant",
  "merchants",
  "money",
  "net",
  "payment",
  "payments",
  "rent",
  "salary",
  "saving",
  "savings",
  "spend",
  "spent",
  "spending",
  "summary",
  "transaction",
  "transactions",
  "travel",
]);

const SUMMARY_PATTERNS = [
  "summary",
  "overview",
  "income",
  "expenses",
  "net",
  "budget",
  "safe to spend",
  "top spending",
  "top categories",
  "top merchants",
  "how much money do i have",
];

const TRANSACTION_PATTERNS = [
  "how much did i spend on",
  "how much did i spend for",
  "how much have i spent on",
  "how did i spend on",
  "how did i spend for",
  "how much on",
  "spending on",
  "where did i spend",
  "which transactions",
  "show transactions",
  "list transactions",
  "what did i spend on",
  "merchant",
  "category",
];

const QUERY_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "could",
  "from",
  "have",
  "last",
  "more",
  "much",
  "show",
  "tell",
  "than",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your",
]);

const QUERY_SYNONYMS = {
  drink: ["coffee", "latte", "tea", "beverage"],
  drinks: ["coffee", "latte", "tea", "beverage"],
  coffee: ["latte", "cafe"],
  latte: ["coffee"],
  beverage: ["coffee", "tea"],
  cafe: ["coffee", "latte"],
};

const ASSISTANT_SCOPE =
  "You can answer only about the user's own finances, transactions, income, expenses, merchants, categories, and monthly summaries.";

function normalizeText(value) {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsAnyPattern(normalized, patterns) {
  return patterns.some((pattern) => normalized.includes(pattern));
}

function isGreeting(normalized) {
  if (GREETING_PHRASES.has(normalized)) return true;
  const words = normalized.split(" ").filter(Boolean);
  return words.length <= 4 && Array.from(GREETING_PHRASES).some((phrase) => normalized.startsWith(phrase));
}

function isExplicitlyOutOfScope(normalized) {
  if (normalized.includes("elon musk")) return true;
  if (normalized.includes("compare me to")) return true;
  if (normalized.includes("compared to ") && !normalized.includes("last month") && !normalized.includes("previous month")) {
    return true;
  }
  return normalized.includes("how much do i weigh");
}

function containsFinanceSignal(normalized) {
  for (const keyword of FINANCE_KEYWORDS) {
    if (normalized.includes(keyword)) return true;
  }
  return (
    normalized.includes("how much did i spend") ||
    normalized.includes("how much have i spent") ||
    normalized.includes("expenses") ||
    normalized.includes("income")
  );
}

function classifyIntent(rawQuestion) {
  const normalized = normalizeText(rawQuestion);
  if (!normalized) return "GREETING";
  if (isGreeting(normalized)) return "GREETING";
  if (isExplicitlyOutOfScope(normalized)) return "OUT_OF_SCOPE";
  if (!containsFinanceSignal(normalized)) return "OUT_OF_SCOPE";
  if (
    containsAnyPattern(normalized, TRANSACTION_PATTERNS) ||
    normalized.includes(" spent on ") ||
    normalized.includes(" spent for ") ||
    normalized.includes(" spend on ") ||
    normalized.includes(" spend for ")
  ) {
    return "TRANSACTION_LOOKUP";
  }
  if (containsAnyPattern(normalized, SUMMARY_PATTERNS)) return "SUMMARY_ONLY";
  return "SUMMARY_ONLY";
}

function formatCurrencyFromCents(amountCents) {
  return `$${(Math.abs(Number(amountCents) || 0) / 100).toFixed(2)}`;
}

function extractQueryTerms(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token)),
    ),
  );
}

function expandQueryTerms(queryTerms) {
  const expanded = new Set(queryTerms);
  queryTerms.forEach((term) => {
    for (const synonym of QUERY_SYNONYMS[term] || []) {
      expanded.add(synonym);
    }
  });
  return Array.from(expanded);
}

function toOccurredOn(occurredAt) {
  if (typeof occurredAt !== "string" || occurredAt.length < 10) return "";
  return occurredAt.slice(0, 10);
}

function toAmountCents(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function toDateLabel(occurredOn, format) {
  if (!occurredOn) return "";
  const parsed = new Date(`${occurredOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-US", { ...format, timeZone: "UTC" }).toLowerCase();
}

function matchedTerms(queryTerms, transaction) {
  if (queryTerms.length === 0) return [];
  const docTerms = new Set([
    ...extractQueryTerms(transaction.merchantName),
    ...extractQueryTerms(transaction.category),
    ...extractQueryTerms(transaction.description),
  ]);
  return queryTerms.filter((term) => docTerms.has(term)).slice(0, 5);
}

function buildReferenceReasons({ merchantMatch, matchedTerms: hits, daysAgo }) {
  const reasons = [];
  if (merchantMatch) reasons.push("merchant phrase match");
  if (hits.length > 0) reasons.push(`matched terms: ${hits.join(", ")}`);
  if (daysAgo <= 30) reasons.push("recent activity");
  if (reasons.length === 0) reasons.push("ranked by recency");
  return reasons;
}

function buildRetrievedSources(transactions, userMessage) {
  const queryTerms = expandQueryTerms(extractQueryTerms(userMessage));
  const normalizedQuery = normalizeText(userMessage);
  if (!Array.isArray(transactions) || transactions.length === 0 || (!normalizedQuery && queryTerms.length === 0)) {
    return [];
  }

  const now = Date.now();
  return transactions
    .map((transaction) => {
      const normalizedMerchant = normalizeText(transaction.merchantName);
      const merchantMatch =
        normalizedQuery &&
        normalizedMerchant &&
        (normalizedQuery.includes(normalizedMerchant) || normalizedMerchant.includes(normalizedQuery));
      const hits = matchedTerms(queryTerms, transaction);
      const lexical = queryTerms.length > 0 ? hits.length / queryTerms.length : 0;
      const boostedLexical = merchantMatch ? Math.max(lexical, 0.85) : lexical;
      const occurredOn = toOccurredOn(transaction.occurredAt);
      const occurredAtMs = occurredOn ? Date.parse(`${occurredOn}T00:00:00Z`) : Date.parse(transaction.occurredAt);
      const daysAgo = Number.isFinite(occurredAtMs) ? Math.max(Math.floor((now - occurredAtMs) / (24 * 60 * 60 * 1000)), 0) : 365;
      const recency = 1 / (1 + daysAgo);
      const score = queryTerms.length > 0 || merchantMatch ? boostedLexical * 0.75 + recency * 0.25 : recency;
      return {
        transaction,
        matchedTerms: hits,
        merchantMatch,
        daysAgo,
        score,
      };
    })
    .filter((candidate) => candidate.merchantMatch || candidate.matchedTerms.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((candidate) => {
      const tx = candidate.transaction;
      return {
        txCode: `t${String(tx.id || "").replace(/-/g, "").slice(0, 8)}`,
        transactionId: tx.id,
        occurredOn: toOccurredOn(tx.occurredAt),
        merchant: tx.merchantName,
        amountCents: toAmountCents(tx.amount),
        category: tx.category || "General",
        score: Number(candidate.score.toFixed(3)),
        matchedTerms: candidate.matchedTerms,
        reasons: buildReferenceReasons(candidate),
      };
    });
}

function sourceMentionedInReply(source, reply) {
  if (!source || typeof reply !== "string" || reply.trim().length === 0) return false;
  const normalizedReply = normalizeText(reply);
  const lowerReply = reply.toLowerCase();
  const normalizedMerchant = normalizeText(source.merchant);
  if (normalizedMerchant && normalizedReply.includes(normalizedMerchant)) return true;
  for (const token of normalizedMerchant.split(" ")) {
    if (token.length >= 5 && normalizedReply.includes(token)) return true;
  }
  for (const term of source.matchedTerms || []) {
    const normalizedTerm = normalizeText(term);
    if (normalizedTerm.length >= 4 && normalizedReply.includes(normalizedTerm)) return true;
  }
  const longDate = toDateLabel(source.occurredOn, { month: "long", day: "numeric", year: "numeric" });
  const shortDate = toDateLabel(source.occurredOn, { month: "short", day: "numeric", year: "numeric" });
  return Boolean((longDate && lowerReply.includes(longDate)) || (shortDate && lowerReply.includes(shortDate)));
}

function filterSourcesForReply(reply, sources, intent) {
  if (intent !== "TRANSACTION_LOOKUP" || !Array.isArray(sources) || sources.length === 0) return [];
  const filtered = sources.filter((source) => sourceMentionedInReply(source, reply));
  return filtered.length > 0 ? filtered : sources.slice(0, 3);
}

function buildFallbackReply(context) {
  if (context?.intent === "TRANSACTION_LOOKUP") {
    const references = Array.isArray(context?.retrievedReferences) ? context.retrievedReferences : [];
    if (references.length > 0) {
      const totalCents = references.reduce((sum, reference) => sum + Math.abs(Number(reference.amountCents) || 0), 0);
      const lines = [
        `You spent a total of ${formatCurrencyFromCents(totalCents)} based on the matching transactions I found:`,
      ];
      references.slice(0, 3).forEach((reference) => {
        lines.push(
          `• ${formatCurrencyFromCents(reference.amountCents)} at ${reference.merchant} on ${reference.occurredOn}.`,
        );
      });
      if (references.length > 3) {
        lines.push(`• ${references.length - 3} more matching transactions were also found.`);
      }
      return lines.join(" ");
    }
    return "I could not find matching transactions for that request in your recent history.";
  }
  if (!context || !context.summary) {
    return "I couldn't retrieve enough data to answer right now. Please try again in a moment.";
  }
  const { summary } = context;
  const totals = summary?.totals || { income: 0, expense: 0, net: 0 };
  const topCategory = summary?.byCategory?.[0];
  const topMerchant = summary?.topMerchants?.[0];
  const lines = [
    "Here's what I can see from your recent activity:",
    `• Income: $${totals.income.toFixed(2)}, Expenses: $${Math.abs(totals.expense).toFixed(2)}, Net: $${totals.net.toFixed(2)}.`,
  ];
  if (topCategory) {
    lines.push(`• Biggest spending category: ${topCategory.category} at $${Math.abs(topCategory.amount).toFixed(2)}.`);
  }
  if (topMerchant) {
    lines.push(`• Top merchant: ${topMerchant.merchant} with $${Math.abs(topMerchant.amount).toFixed(2)} spent.`);
  }
  lines.push("Let me know if you'd like to dive deeper into any of these details!");
  return lines.join(" ");
}

module.exports = {
  ASSISTANT_SCOPE,
  buildFallbackReply,
  buildRetrievedSources,
  classifyIntent,
  filterSourcesForReply,
};
