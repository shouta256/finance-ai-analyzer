#!/usr/bin/env node

/**
 * Minimal RAG demo pipeline.
 * 1. Load dummy household CSV.
 * 2. Build text embeddings (simple bag-of-words cosine).
 * 3. Produce monthly/category/merchant summaries.
 * 4. Run sample Q&A retrieval.
 * 5. Write artifacts to examples/.
 *
 * Usage: node scripts/rag-demo.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const INPUT_PATH = path.join(EXAMPLES_DIR, "rag-demo-input.csv");
const SUMMARY_OUTPUT = path.join(EXAMPLES_DIR, "rag-demo-summary.json");
const QA_OUTPUT = path.join(EXAMPLES_DIR, "rag-demo-qa.json");

async function ensureExamplesDir() {
  await mkdir(EXAMPLES_DIR, { recursive: true });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(",");
  return rows.map((row) => {
    const values = row.split(",");
    return headers.reduce((acc, key, idx) => {
      acc[key] = values[idx];
      return acc;
    }, {});
  });
}

function toNumber(value) {
  return Number.parseFloat(value);
}

function normalizeToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  return (text.toLowerCase().match(/\p{L}+\p{N}*|\p{N}+/gu) ?? [])
    .map(normalizeToken)
    .filter((token) => token.length >= 3);
}

function embed(text) {
  const tokens = tokenize(text);
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let norm = 0;
  for (const value of counts.values()) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  return { counts, norm };
}

function cosineSim(vecA, vecB) {
  let dot = 0;
  const [a, b] = vecA.counts.size < vecB.counts.size ? [vecA, vecB] : [vecB, vecA];
  for (const [token, value] of a.counts.entries()) {
    const other = b.counts.get(token);
    if (other) dot += value * other;
  }
  return dot / (vecA.norm * vecB.norm);
}

function buildSummaries(transactions) {
  const totals = { income: 0, expense: 0, net: 0 };
  const categories = new Map();
  const merchants = new Map();

  for (const tx of transactions) {
    const amount = toNumber(tx.amount);
    if (amount >= 0) {
      totals.income += amount;
    } else {
      totals.expense += amount;
      const catSum = categories.get(tx.category) ?? { amount: 0, count: 0 };
      catSum.amount += amount;
      catSum.count += 1;
      categories.set(tx.category, catSum);

      const merchSum = merchants.get(tx.merchant) ?? { amount: 0, count: 0 };
      merchSum.amount += amount;
      merchSum.count += 1;
      merchants.set(tx.merchant, merchSum);
    }
  }
  totals.net = totals.income + totals.expense;

  const expenseAbsTotal = Array.from(categories.values()).reduce(
    (acc, cat) => acc + Math.abs(cat.amount),
    0,
  ) || 1;

  const categoryBreakdown = Array.from(categories.entries())
    .map(([category, data]) => ({
      category,
      amount: Number((data.amount).toFixed(2)),
      percentage: Number(((Math.abs(data.amount) / expenseAbsTotal) * 100).toFixed(2)),
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const merchantBreakdown = Array.from(merchants.entries())
    .map(([merchant, data]) => ({
      merchant,
      amount: Number((data.amount).toFixed(2)),
      transactionCount: data.count,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    month: "2025-08",
    totals: {
      income: Number(totals.income.toFixed(2)),
      expense: Number(totals.expense.toFixed(2)),
      net: Number(totals.net.toFixed(2)),
    },
    byCategory: categoryBreakdown,
    topMerchants: merchantBreakdown,
  };
}

function buildRetrieval(transactions, questions) {
  const txVectors = transactions.map((tx) => ({
    tx,
    vector: embed(`${tx.merchant} ${tx.description}`),
    tokens: new Set(tokenize(`${tx.merchant} ${tx.category} ${tx.description}`).map((t) => t.toLowerCase())),
  }));

  return questions.map((question) => {
    const qVec = embed(question);
    const questionTokens = new Set(tokenize(question).map((t) => t.toLowerCase()));
    const scored = txVectors
      .map(({ tx, vector, tokens: txTokens }) => ({
        tx,
        score: cosineSim(qVec, vector),
        overlap: [...txTokens].some((token) => questionTokens.has(token)),
      }))
      .sort((a, b) => b.score - a.score);

    const positiveMatches = scored.filter((entry) => entry.score > 0 && toNumber(entry.tx.amount) < 0);
    const keywordMatches = scored.filter((entry) => entry.overlap);
    const fallbackMatches = scored
      .filter((entry) => toNumber(entry.tx.amount) < 0)
      .sort((a, b) => Math.abs(toNumber(b.tx.amount)) - Math.abs(toNumber(a.tx.amount)));

    const candidate = positiveMatches.length
      ? positiveMatches
      : keywordMatches.length
        ? keywordMatches
        : fallbackMatches;

    const chosen = candidate.slice(0, 3);

    return {
      question,
      topMatches: chosen.map(({ tx, score }) => ({
        id: tx.id,
        date: tx.date,
        merchant: tx.merchant,
        amount: Number(toNumber(tx.amount).toFixed(2)),
        category: tx.category,
        description: tx.description,
        score: Number(score.toFixed(4)),
      })),
    };
  });
}

async function main() {
  await ensureExamplesDir();
  const csvText = await readFile(INPUT_PATH, "utf8");
  const transactions = parseCsv(csvText);

  const summary = buildSummaries(transactions);
  const qa = buildRetrieval(transactions, [
    "How much did we spend at Starbucks?",
    "What are the travel expenses this month?",
    "How large were the recent utility bills?",
  ]);

  await writeFile(SUMMARY_OUTPUT, JSON.stringify(summary, null, 2));
  await writeFile(QA_OUTPUT, JSON.stringify({ questions: qa }, null, 2));

  console.log("✅ RAG demo generated.");
  console.log(`   Summary -> ${path.relative(ROOT, SUMMARY_OUTPUT)}`);
  console.log(`   Q&A -> ${path.relative(ROOT, QA_OUTPUT)}`);
  console.log("   Try opening these files to inspect the results.");
}

main().catch((error) => {
  console.error("Demo pipeline failed:", error);
  process.exitCode = 1;
});
