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
  };
}

/**
 * Get conversation for client
 */
async function getConversationForClient(client, requestedConversationId) {
  let conversationId = requestedConversationId;
  let rows = [];
  
  if (conversationId) {
    const res = await client.query(
      `SELECT id, conversation_id, role, content, created_at
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
        `SELECT id, conversation_id, role, content, created_at
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
async function gatherChatContext(client, userId) {
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
  
  return { summary: cleanSummary, recentTransactions };
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
  const context = await gatherChatContext(client, userId);
  const historyForAi = priorMessages.map((msg) => ({
    role: msg.role,
    content: truncateText(msg.content || "", CHAT_HISTORY_CHAR_LIMIT),
  }));
  
  const aiReply = await callAiAssistant(historyForAi, userMessage, context, traceId);
  if (aiReply && aiReply.trim()) {
    return aiReply.trim();
  }
  return buildFallbackReply(context);
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
          
          const assistantContent = await generateAssistantReply(
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
              { id: crypto.randomUUID(), role: "USER", content: rawMessage, createdAt: nowIso },
              { id: crypto.randomUUID(), role: "ASSISTANT", content: assistantContent, createdAt: new Date().toISOString() },
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
        
        const assistantContent = await generateAssistantReply(
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
          `INSERT INTO chat_messages (id, conversation_id, user_id, role, content, created_at)
           VALUES ($1, $2, current_setting('appsec.user_id', true)::uuid, 'ASSISTANT', $3, $4)`,
          [assistantId, conversationId, assistantContent, assistantCreatedAt],
        );

        const updatedMessages = messages.concat([
          { id: assistantId, role: "ASSISTANT", content: assistantContent, createdAt: assistantCreatedAt },
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
