"use strict";

const {
  round,
  formatUsd,
  humaniseLabel,
  toIsoDate,
} = require("../utils/helpers");
const {
  HIGHLIGHT_MAX_TOKENS,
  HIGHLIGHT_TOP_CATEGORY_LIMIT,
  HIGHLIGHT_TOP_MERCHANT_LIMIT,
  HIGHLIGHT_TRANSACTIONS_LIMIT,
} = require("../utils/constants");
const { callGeminiHighlight, callOpenAiHighlight, hasGeminiCredentials, hasOpenAiCredentials } = require("./ai");

/**
 * Build deterministic highlight (no AI)
 */
function buildDeterministicHighlight(totals, categories, merchants) {
  const income = Number(totals?.income ?? 0);
  const rawExpense = Number(totals?.expense ?? 0);
  const expense = Math.abs(rawExpense);
  const net = Number(totals?.net ?? income + rawExpense);

  const summaryParts = [
    `Income ${formatUsd(income, { absolute: true })} vs spend ${formatUsd(expense, { absolute: true })} leads to net ${formatUsd(net)}.`,
  ];

  const topCategory = Array.isArray(categories) && categories.length > 0 ? categories[0] : null;
  if (topCategory?.category) {
    summaryParts.push(
      `Largest category: ${humaniseLabel(topCategory.category)} at ${formatUsd(Math.abs(Number(topCategory.amount ?? 0)), { absolute: true })}.`,
    );
  }

  const topMerchant = Array.isArray(merchants) && merchants.length > 0 ? merchants[0] : null;
  const topMerchantAmount = Number(topMerchant?.amount ?? 0);
  if (topMerchant?.merchant) {
    summaryParts.push(
      `Top merchant: ${topMerchant.merchant} with ${formatUsd(Math.abs(topMerchantAmount), { absolute: true })} across ${Number(topMerchant.transactionCount ?? 0)} transactions.`,
    );
  }

  let sentiment = "NEUTRAL";
  if (net > 0) sentiment = "POSITIVE";
  else if (net < -100) sentiment = "NEGATIVE";

  const recommendations = new Set();
  if (net < 0) {
    recommendations.add("Net outflow. Review discretionary spending and adjust upcoming budgets.");
  } else {
    recommendations.add("Net positive month. Allocate part of the surplus to savings or debt repayment.");
  }
  if (topCategory?.category) {
    recommendations.add(`Inspect recent ${humaniseLabel(topCategory.category).toLowerCase()} purchases for savings opportunities.`);
  }
  if (topMerchant?.merchant && topMerchantAmount < 0 && Math.abs(topMerchantAmount) > 200) {
    recommendations.add(`Set a spending alert for ${topMerchant.merchant} next month.`);
  }
  if (recommendations.size < 3) {
    recommendations.add("Schedule a quick budget check-in and update category limits.");
  }

  return {
    title: "Monthly financial health",
    summary: summaryParts.join(" "),
    sentiment,
    recommendations: Array.from(recommendations).slice(0, 4),
  };
}

/**
 * Build prompt for AI highlight generation
 */
function buildHighlightPrompt(summary, transactions) {
  const totals = summary?.totals ?? {};
  const anomalies = Array.isArray(summary?.anomalies) ? summary.anomalies : [];
  const categories = Array.isArray(summary?.byCategory) ? summary.byCategory : [];
  const merchants = Array.isArray(summary?.topMerchants) ? summary.topMerchants : [];

  const income = Number(totals.income ?? 0);
  const expense = Math.abs(Number(totals.expense ?? 0));
  const net = Number(totals.net ?? income + Number(totals.expense ?? 0));

  const categoryLines = categories
    .slice(0, HIGHLIGHT_TOP_CATEGORY_LIMIT)
    .map((entry) =>
      `- ${humaniseLabel(entry.category)}: ${formatUsd(Math.abs(Number(entry.amount ?? 0)), { absolute: true })} (${Number(entry.percentage ?? 0).toFixed(2)}%)`
    )
    .join("\n");

  const merchantLines = merchants
    .slice(0, HIGHLIGHT_TOP_MERCHANT_LIMIT)
    .map((entry) =>
      `- ${entry.merchant}: ${formatUsd(Math.abs(Number(entry.amount ?? 0)), { absolute: true })} (${Number(entry.transactionCount ?? 0)} transactions)`
    )
    .join("\n");

  const anomalyLines = anomalies
    .slice(0, 5)
    .map((entry) =>
      `- ${entry.merchantName || "Unknown"}: amount ${formatUsd(Number(entry.amount ?? 0))}, delta ${formatUsd(Number(entry.deltaAmount ?? 0))}, impact ${Number(entry.budgetImpactPercent ?? 0).toFixed(2)}%`
    )
    .join("\n");

  const transactionLines = transactions
    .slice(0, HIGHLIGHT_TRANSACTIONS_LIMIT)
    .map((tx) => {
      const occurred = tx.occurredAt ? String(tx.occurredAt).slice(0, 10) : "unknown-date";
      return `- ${occurred} ${tx.merchantName || "Unknown"} ${formatUsd(Number(tx.amount ?? 0))} ${humaniseLabel(tx.category || "Uncategorized")}`;
    })
    .join("\n");

  return [
    "Financial snapshot:",
    `Income: ${formatUsd(income, { absolute: true })}`,
    `Spend: ${formatUsd(expense, { absolute: true })}`,
    `Net: ${formatUsd(net)}`,
    "",
    "Top categories:",
    categoryLines || "- none",
    "",
    "Top merchants:",
    merchantLines || "- none",
    "",
    "Anomalies:",
    anomalyLines || "- none",
    "",
    `Recent transactions (latest ${Math.min(HIGHLIGHT_TRANSACTIONS_LIMIT, transactions.length)}):`,
    transactionLines || "- none",
    "",
    "Return JSON only.",
  ].join("\n");
}

/**
 * Parse AI highlight response
 */
function parseAiHighlightResponse(raw, fallback) {
  if (!raw) return null;
  let text;
  if (typeof raw === "string") {
    text = raw.trim();
  } else if (raw && typeof raw === "object") {
    try { text = JSON.stringify(raw); } catch { text = ""; }
  }
  if (!text) return null;

  // Strip markdown code fences
  if (text.startsWith("```")) {
    const firstNl = text.indexOf("\n");
    if (firstNl >= 0) text = text.slice(firstNl + 1);
    const lastFence = text.lastIndexOf("```");
    if (lastFence >= 0) text = text.slice(0, lastFence);
    text = text.trim();
  }

  // Extract JSON
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }

  const highlight = {
    title: fallback.title,
    summary: fallback.summary,
    sentiment: fallback.sentiment,
    recommendations: Array.isArray(fallback.recommendations) ? [...fallback.recommendations] : [],
  };

  if (typeof parsed.title === "string" && parsed.title.trim()) {
    highlight.title = parsed.title.trim();
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    highlight.summary = parsed.summary.trim();
  }
  if (typeof parsed.sentiment === "string") {
    const candidate = parsed.sentiment.trim().toUpperCase();
    if (candidate === "POSITIVE" || candidate === "NEUTRAL" || candidate === "NEGATIVE") {
      highlight.sentiment = candidate;
    }
  }
  if (Array.isArray(parsed.recommendations)) {
    const cleaned = parsed.recommendations
      .map((item) => (typeof item === "string" ? item.trim() : null))
      .filter(Boolean);
    if (cleaned.length > 0) {
      highlight.recommendations = Array.from(new Set(cleaned)).slice(0, 6);
    }
  }
  return highlight;
}

/**
 * Generate AI highlight for summary
 */
async function generateAiHighlight(summary, transactions, traceId) {
  const fallback = buildDeterministicHighlight(summary?.totals, summary?.byCategory, summary?.topMerchants);
  const provider = (process.env.SAFEPOCKET_AI_PROVIDER || "gemini").toLowerCase();
  const model = process.env.SAFEPOCKET_AI_MODEL || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-4.1-mini");
  const prompt = buildHighlightPrompt(summary, transactions);

  try {
    let raw;
    if (provider === "gemini") {
      if (!hasGeminiCredentials()) {
        console.warn("[analytics] Gemini highlight requested but no API key configured");
        return fallback;
      }
      raw = await callGeminiHighlight(model, prompt, HIGHLIGHT_MAX_TOKENS, traceId);
    } else {
      if (!hasOpenAiCredentials()) {
        console.warn("[analytics] OpenAI highlight requested but no API key configured");
        return fallback;
      }
      raw = await callOpenAiHighlight(model, prompt, HIGHLIGHT_MAX_TOKENS, traceId);
    }
    
    if (!raw) return fallback;
    const parsed = parseAiHighlightResponse(raw, fallback);
    return parsed || fallback;
  } catch (error) {
    console.warn("[analytics] AI highlight generation failed", { message: error?.message, traceId });
    return fallback;
  }
}

/**
 * Check if AI highlight should be generated
 */
function shouldGenerateAiHighlight(query) {
  if (!query) return false;
  const raw =
    query.generateAi ??
    query.generateai ??
    query.generate_ai ??
    query.generate_ai_summary ??
    query.generateAISummary ??
    "";
  if (raw === true) return true;
  if (raw === false) return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * Summarize transactions
 */
function summarise(transactions, fromDate, toDate, monthLabel, traceId) {
  let income = 0;
  let expense = 0;
  const categoryTotals = new Map();
  const merchantTotals = new Map();
  const monthNet = {};

  transactions.forEach((tx) => {
    const amt = Number(tx.amount);
    if (amt > 0) income += amt;
    if (amt < 0) expense += amt;

    const category = tx.category || "Uncategorized";
    if (!categoryTotals.has(category)) categoryTotals.set(category, 0);
    if (amt < 0) categoryTotals.set(category, categoryTotals.get(category) + amt);

    const merchant = tx.merchantName || "Unknown";
    if (!merchantTotals.has(merchant)) merchantTotals.set(merchant, { total: 0, count: 0 });
    const stats = merchantTotals.get(merchant);
    stats.total += amt;
    stats.count += 1;

    const monthKey = tx.occurredAt.slice(0, 7);
    monthNet[monthKey] = round((monthNet[monthKey] || 0) + amt);
  });

  const totalExpenses = Array.from(categoryTotals.values()).reduce((sum, value) => sum + Math.abs(value), 0);
  const categories = Array.from(categoryTotals.entries())
    .map(([category, amount]) => ({
      category,
      amount: round(amount),
      percentage: totalExpenses === 0 ? 0 : round((Math.abs(amount) / totalExpenses) * 100),
    }))
    .filter((entry) => entry.amount < 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 8);

  const merchants = Array.from(merchantTotals.entries())
    .map(([merchant, stats]) => ({
      merchant,
      amount: round(stats.total),
      transactionCount: stats.count,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5);

  const net = income + expense;
  const cycleStart = new Date(fromDate);
  const cycleEnd = new Date(toDate.getTime() - 1);
  const today = new Date();
  const daysRemaining = Math.max(1, Math.ceil((cycleEnd.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)));
  const variableBudget = round(Math.abs(expense));
  const totals = { income: round(income), expense: round(expense), net: round(net) };
  const fallbackHighlight = buildDeterministicHighlight(totals, categories, merchants);

  const effectiveMonth = monthLabel || new Date().toISOString().slice(0, 7);
  
  return {
    month: effectiveMonth,
    totals,
    byCategory: categories,
    topMerchants: merchants,
    anomalies: [],
    aiHighlight: fallbackHighlight,
    latestHighlight: null,
    safeToSpend: {
      cycleStart: toIsoDate(cycleStart),
      cycleEnd: toIsoDate(cycleEnd),
      safeToSpendToday: round(net > 0 ? net / daysRemaining : 0),
      hardCap: round(net > 0 ? net : 0),
      dailyBase: daysRemaining > 0 ? round(Math.abs(expense) / daysRemaining) : 0,
      dailyAdjusted: daysRemaining > 0 ? round(Math.abs(expense) / daysRemaining) : 0,
      rollToday: 0,
      paceRatio: 1,
      adjustmentFactor: 1,
      daysRemaining,
      variableBudget,
      variableSpent: variableBudget,
      remainingVariableBudget: 0,
      danger: net <= 0,
      notes: [],
    },
    traceId,
  };
}

/**
 * Build aggregates for transactions
 */
function buildTransactionsAggregates(transactions) {
  let income = 0;
  let expense = 0;
  const monthNet = {};
  const categoryTotals = {};

  transactions.forEach((tx) => {
    const amt = Number(tx.amount);
    if (amt > 0) income += amt;
    if (amt < 0) {
      expense += amt;
      categoryTotals[tx.category] = round((categoryTotals[tx.category] || 0) + amt);
    }
    const monthKey = tx.occurredAt.slice(0, 7);
    monthNet[monthKey] = round((monthNet[monthKey] || 0) + amt);
  });

  return {
    incomeTotal: round(income),
    expenseTotal: round(expense),
    netTotal: round(income + expense),
    monthNet,
    categoryTotals,
    count: transactions.length,
  };
}

module.exports = {
  buildDeterministicHighlight,
  buildHighlightPrompt,
  parseAiHighlightResponse,
  generateAiHighlight,
  shouldGenerateAiHighlight,
  summarise,
  buildTransactionsAggregates,
};
