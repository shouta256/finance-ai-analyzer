"use strict";

const crypto = require("crypto");
const { authenticate } = require("../services/auth");
const { respond } = require("../utils/response");
const { parseRange } = require("../utils/helpers");
const { queryTransactions } = require("../services/transactions");
const {
  summarise,
  generateAiHighlight,
  shouldGenerateAiHighlight,
} = require("../services/analytics");

/**
 * Handle GET /analytics/summary
 */
async function handleAnalyticsSummary(event) {
  const payload = await authenticate(event);
  const query = event.queryStringParameters || {};
  const { fromDate, toDate, monthLabel } = parseRange(query);
  const traceId = event.requestContext?.requestId || crypto.randomUUID();
  const generateAi = shouldGenerateAiHighlight(query);
  
  try {
    const transactions = await queryTransactions(payload.sub, fromDate, toDate);
    const summary = summarise(transactions, fromDate, toDate, monthLabel, traceId);
    
    if (generateAi) {
      const aiHighlight = await generateAiHighlight(summary, transactions, traceId);
      if (aiHighlight) {
        summary.aiHighlight = aiHighlight;
        summary.latestHighlight = {
          month: monthLabel || summary.month,
          highlight: aiHighlight,
        };
      }
    }
    
    return respond(event, 200, summary);
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    return respond(event, status, {
      error: {
        code: "ANALYTICS_FETCH_FAILED",
        message: error?.message || "Failed to load analytics summary",
        traceId,
      },
    });
  }
}

module.exports = {
  handleAnalyticsSummary,
};
