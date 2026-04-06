"use strict";

const crypto = require("crypto");
const { authenticate } = require("../services/auth");
const { callAiAssistant } = require("../services/ai");
const { summarise } = require("../services/analytics");
const {
  queryTransactionsWithClient,
  ensureUserRow,
} = require("../services/transactions");
const { respond } = require("../utils/response");
const { parseJsonBody, truncateText } = require("../utils/helpers");
const { withUserClient } = require("../db/pool");
const {
  UUID_REGEX,
  DEV_USER_ID,
  CHAT_MAX_HISTORY_MESSAGES,
  CHAT_HISTORY_CHAR_LIMIT,
} = require("../utils/constants");

// Chat tables check cache
let chatTablesEnsured = false;
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

/**
 * Check if user is demo user
 */
function isDemoUser(userId) {
  return userId === DEV_USER_ID;
}

/**
 * Ensure chat tables exist
 */
async function ensureChatTables(client) {
  if (chatTablesEnsured) return;
  try {
    const res = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'chat_messages'
       LIMIT 1`,
    );
    if (res.rowCount === 0) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id uuid PRIMARY KEY,
          conversation_id uuid NOT NULL,
          user_id uuid NOT NULL REFERENCES users(id),
          role text NOT NULL CHECK (role IN ('USER','ASSISTANT')),
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
           ON chat_messages(conversation_id, created_at)`,
      );
    }
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata_json text`);
    chatTablesEnsured = true;
  } catch (error) {
    console.warn("[chat] failed to ensure chat tables", { message: error?.message });
    throw error;
  }
}

/**
 * Map chat message row
 */
function mapChatRow(row) {
  const createdAt =
    row.created_at instanceof Date && !Number.isNaN(row.created_at.getTime())
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString();
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt,
    sources: parseSources(row.metadata_json),
  };
}

function parseSources(metadataJson) {
  if (!metadataJson) return [];
  try {
    const parsed = typeof metadataJson === "string" ? JSON.parse(metadataJson) : metadataJson;
    return Array.isArray(parsed?.sources) ? parsed.sources : [];
  } catch (error) {
    console.warn("[chat] failed to parse metadata_json", { message: error?.message });
    return [];
  }
}

function serializeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return JSON.stringify({ sources });
}

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
  const candidates = transactions
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

  return candidates;
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

/**
 * Get conversation for client
 */
async function getConversationForClient(client, requestedConversationId) {
  let conversationId = requestedConversationId;
  let rows = [];
  
  if (conversationId) {
    const res = await client.query(
      `SELECT id, conversation_id, role, content, metadata_json, created_at
       FROM chat_messages
       WHERE conversation_id = $1
         AND user_id = current_setting('appsec.user_id', true)::uuid
       ORDER BY created_at ASC`,
      [conversationId],
    );
    rows = res.rows;
  } else {
    const latest = await client.query(
      `SELECT conversation_id
       FROM chat_messages
       WHERE user_id = current_setting('appsec.user_id', true)::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (latest.rowCount > 0) {
      conversationId = latest.rows[0].conversation_id;
      const res = await client.query(
        `SELECT id, conversation_id, role, content, metadata_json, created_at
         FROM chat_messages
         WHERE conversation_id = $1
           AND user_id = current_setting('appsec.user_id', true)::uuid
         ORDER BY created_at ASC`,
        [conversationId],
      );
      rows = res.rows;
    } else {
      conversationId = crypto.randomUUID();
      rows = [];
    }
  }
  return { conversationId, messages: rows.map(mapChatRow) };
}

/**
 * Delete conversation tail from a specific message
 */
async function deleteConversationTail(client, messageId) {
  if (!messageId) return null;
  const res = await client.query(
    `SELECT conversation_id, created_at
     FROM chat_messages
     WHERE id = $1
       AND user_id = current_setting('appsec.user_id', true)::uuid
     LIMIT 1`,
    [messageId],
  );
  if (res.rowCount === 0) return null;
  
  const { conversation_id: conversationId, created_at: createdAt } = res.rows[0];
  await client.query(
    `DELETE FROM chat_messages
     WHERE conversation_id = $1
       AND user_id = current_setting('appsec.user_id', true)::uuid
       AND created_at >= $2`,
    [conversationId, createdAt],
  );
  return conversationId;
}

/**
 * Select history for AI context
 */
function selectHistoryForAi(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const limit = Math.max(CHAT_MAX_HISTORY_MESSAGES, 0);
  if (limit === 0) return [];
  const trimmed = messages.slice(0, -1);
  const start = Math.max(0, trimmed.length - limit * 2);
  return trimmed.slice(start);
}

/**
 * Gather chat context for AI
 */
async function gatherChatContext(client, userId, userMessage) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  let transactions = [];
  
  try {
    transactions = await queryTransactionsWithClient(client, start, now);
  } catch (error) {
    console.warn("[chat] failed to load transactions for context", { message: error?.message });
  }
  
  const traceId = crypto.randomUUID();
  let summary = null;
  try {
    summary = summarise(transactions, start, now, null, traceId);
  } catch (error) {
    console.warn("[chat] failed to summarise transactions", { message: error?.message });
  }
  
  let cleanSummary = null;
  if (summary) {
    const { safeToSpend, ...rest } = summary;
    cleanSummary = {
      ...rest,
      budgetStatus: safeToSpend ? {
        safeToSpendToday: `$${safeToSpend.safeToSpendToday?.toFixed(2) || '0.00'}`,
        dailyBudget: `$${safeToSpend.dailyBase?.toFixed(2) || '0.00'}`,
        daysRemaining: safeToSpend.daysRemaining || 0,
        status: safeToSpend.danger ? 'Over budget - spending exceeds income' : 'On track - within budget',
        riskLevel: safeToSpend.danger ? 'High' : 'Low',
      } : null,
    };
  }
  
  const recentTransactions = transactions.slice(0, 25).map((tx) => ({
    id: tx.id,
    occurredAt: tx.occurredAt,
    merchant: tx.merchantName,
    amount: tx.amount,
    category: tx.category,
    pending: tx.pending,
  }));

  const intent = classifyIntent(userMessage);
  const context = {
    intent,
    question: userMessage || "",
    assistantScope: ASSISTANT_SCOPE,
  };

  if (intent === "GREETING" || intent === "OUT_OF_SCOPE") {
    context.capabilities = [
      "monthly summaries",
      "spending by merchant or category",
      "income and expense questions",
    ];
    context.retrievedReferences = [];
    return context;
  }

  context.summary = cleanSummary;
  context.recentTransactions = recentTransactions;
  context.retrievedReferences = intent === "TRANSACTION_LOOKUP" ? buildRetrievedSources(transactions, userMessage) : [];
  return context;
}

/**
 * Build fallback reply when AI is unavailable
 */
function buildFallbackReply(context) {
  if (!context || !context.summary) {
    return "I couldn't retrieve enough data to answer right now. Please try again in a moment.";
  }
  const { summary } = context;
  const totals = summary?.totals || { income: 0, expense: 0, net: 0 };
  const topCategory = summary?.byCategory?.[0];
  const topMerchant = summary?.topMerchants?.[0];
  const lines = [
    `Here's what I can see from your recent activity:`,
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

/**
 * Generate assistant reply
 */
async function generateAssistantReply(client, userId, conversationId, userMessage, priorMessages, traceId) {
  const context = await gatherChatContext(client, userId, userMessage);
  const historyForAi = priorMessages.map((msg) => ({
    role: msg.role,
    content: truncateText(msg.content || "", CHAT_HISTORY_CHAR_LIMIT),
  }));
  
  const aiReply = await callAiAssistant(historyForAi, userMessage, context, traceId);
  if (aiReply && aiReply.trim()) {
    return {
      content: aiReply.trim(),
      sources: filterSourcesForReply(aiReply, context.retrievedReferences || [], context.intent),
    };
  }
  return { content: buildFallbackReply(context), sources: [] };
}

/**
 * Handle chat requests (GET, POST, DELETE)
 */
async function handleChat(event) {
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const payload = await authenticate(event);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  const isDemo = isDemoUser(payload.sub);

  const respondWithError = (error) => {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "CHAT_OPERATION_FAILED",
        message: error?.message || "Chat operation failed",
        traceId,
      },
    });
  };

  // GET - Fetch conversation
  if (method === "GET") {
    if (isDemo) {
      return respond(event, 200, { 
        conversationId: crypto.randomUUID(), 
        messages: [], 
        traceId,
        isDemo: true 
      });
    }
    
    const requestedId = event.queryStringParameters?.conversationId;
    try {
      const conversationId = UUID_REGEX.test(requestedId || "") ? requestedId : null;
      const result = await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        return getConversationForClient(client, conversationId);
      });
      return respond(event, 200, { ...result, traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  // POST - Send message
  if (method === "POST") {
    let body;
    try {
      body = parseJsonBody(event);
    } catch {
      return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } });
    }
    
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) {
      return respond(event, 400, { error: { code: "INVALID_REQUEST", message: "message is required" } });
    }
    
    const rawConversationId = typeof body.conversationId === "string" && UUID_REGEX.test(body.conversationId) 
      ? body.conversationId 
      : null;
    const truncateId = typeof body.truncateFromMessageId === "string" && UUID_REGEX.test(body.truncateFromMessageId)
      ? body.truncateFromMessageId
      : null;

    // Demo users - don't persist chat
    if (isDemo) {
      try {
        const result = await withUserClient(payload.sub, async (client) => {
          await ensureChatTables(client);
          await ensureUserRow(client, payload);
          
          const conversationId = rawConversationId || crypto.randomUUID();
          const nowIso = new Date().toISOString();
          
          const assistantReply = await generateAssistantReply(
            client,
            payload.sub,
            conversationId,
            rawMessage,
            [],
            traceId,
          );

          return {
            conversationId,
            messages: [
              { id: crypto.randomUUID(), role: "USER", content: rawMessage, createdAt: nowIso, sources: [] },
              {
                id: crypto.randomUUID(),
                role: "ASSISTANT",
                content: assistantReply.content,
                createdAt: new Date().toISOString(),
                sources: assistantReply.sources,
              },
            ],
            isDemo: true,
          };
        });
        return respond(event, 200, { ...result, traceId });
      } catch (error) {
        return respondWithError(error);
      }
    }

    // Regular users - persist chat history
    try {
      const result = await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        let conversationId = rawConversationId;

        if (truncateId) {
          const truncatedConversationId = await deleteConversationTail(client, truncateId);
          if (truncatedConversationId) {
            conversationId = truncatedConversationId;
          }
        }

        if (!conversationId) {
          conversationId = crypto.randomUUID();
        }

        const nowIso = new Date().toISOString();
        const userMessageId = crypto.randomUUID();
        await client.query(
          `INSERT INTO chat_messages (id, conversation_id, user_id, role, content, created_at)
           VALUES ($1, $2, current_setting('appsec.user_id', true)::uuid, 'USER', $3, $4)`,
          [userMessageId, conversationId, rawMessage, nowIso],
        );

        const conversation = await getConversationForClient(client, conversationId);
        const messages = conversation.messages;
        const latestUserMessage = messages[messages.length - 1];
        const priorMessages = selectHistoryForAi(messages);
        
        const assistantReply = await generateAssistantReply(
          client,
          payload.sub,
          conversationId,
          latestUserMessage?.content || rawMessage,
          priorMessages,
          traceId,
        );

        const assistantId = crypto.randomUUID();
        const assistantCreatedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO chat_messages (id, conversation_id, user_id, role, content, metadata_json, created_at)
           VALUES ($1, $2, current_setting('appsec.user_id', true)::uuid, 'ASSISTANT', $3, $4, $5)`,
          [assistantId, conversationId, assistantReply.content, serializeSources(assistantReply.sources), assistantCreatedAt],
        );

        const updatedMessages = messages.concat([
          {
            id: assistantId,
            role: "ASSISTANT",
            content: assistantReply.content,
            createdAt: assistantCreatedAt,
            sources: assistantReply.sources,
          },
        ]);

        return { conversationId, messages: updatedMessages };
      });

      return respond(event, 200, { ...result, traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  // DELETE - Delete conversation
  if (method === "DELETE") {
    try {
      const requestedId = event.queryStringParameters?.conversationId;
      await withUserClient(payload.sub, async (client) => {
        await ensureChatTables(client);
        await ensureUserRow(client, payload);
        if (requestedId && UUID_REGEX.test(requestedId)) {
          await client.query(
            `DELETE FROM chat_messages
             WHERE user_id = current_setting('appsec.user_id', true)::uuid
               AND conversation_id = $1`,
            [requestedId],
          );
        } else {
          await client.query(
            `DELETE FROM chat_messages
             WHERE user_id = current_setting('appsec.user_id', true)::uuid`,
          );
        }
      });
      return respond(event, 200, { status: "DELETED", traceId });
    } catch (error) {
      return respondWithError(error);
    }
  }

  return respond(event, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Unsupported chat method" } });
}

module.exports = {
  handleChat,
};
