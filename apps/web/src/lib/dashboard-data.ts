import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { analyticsSummarySchema, transactionsListSchema } from "./schemas";

export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;
export type TransactionsList = z.infer<typeof transactionsListSchema>;
const enableServerLogs = process.env.NODE_ENV !== "production";

export async function getDashboardData(month: string): Promise<{
  summary: AnalyticsSummary;
  transactions: TransactionsList;
}> {
  try {
    const headerList = headers();
    const cookieStore = cookies();
    const token = cookieStore.get("sp_token")?.value;
    if (!token) {
      if (enableServerLogs) {
        console.info("[dashboard] No sp_token cookie on server request; using fallback data.");
      }
      return {
        summary: buildFallbackSummary(month),
        transactions: buildFallbackTransactions(month),
      };
    }
    const cookieHeader = cookieStore
      .getAll()
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const protocol = headerList.get("x-forwarded-proto") ?? "http";
    const host = headerList.get("host") ?? "localhost:3000";
    const appBaseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? `${protocol}://${host}`;
    const commonHeaders = new Headers();
    if (cookieHeader) {
      commonHeaders.set("cookie", cookieHeader);
    }
    if (token) {
      commonHeaders.set("authorization", `Bearer ${token}`);
    }

    const summaryUrl = new URL(`/api/analytics/summary?month=${month}`, appBaseUrl);
    const summaryResponse = await fetch(summaryUrl, {
      headers: commonHeaders,
      cache: "no-store",
    });
    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      redirect("/login?redirect=/dashboard");
    }
    if (!summaryResponse.ok) {
      const details = await safeJson(summaryResponse);
      throw new Error(details ?? `Failed to load analytics: ${summaryResponse.statusText}`);
    }
    const summaryJson = await summaryResponse.json();
    const summary = analyticsSummarySchema.parse(summaryJson);

    const transactionsUrl = new URL(`/api/transactions?month=${month}`, appBaseUrl);
    const transactionsResponse = await fetch(transactionsUrl, {
      headers: commonHeaders,
      cache: "no-store",
    });
    if (transactionsResponse.status === 401 || transactionsResponse.status === 403) {
      redirect("/login?redirect=/dashboard");
    }
    if (!transactionsResponse.ok) {
      const details = await safeJson(transactionsResponse);
      throw new Error(details ?? `Failed to load transactions: ${transactionsResponse.statusText}`);
    }
    const transactionsJson = await transactionsResponse.json();
    const parsedTransactions = transactionsListSchema.parse(transactionsJson);
    const normalizedPeriod = {
      month: parsedTransactions.period?.month ?? parsedTransactions.month ?? month,
      from: parsedTransactions.period?.from ?? null,
      to: parsedTransactions.period?.to ?? null,
    };
    const transactions = {
      ...parsedTransactions,
      period: normalizedPeriod,
    };
    return { summary, transactions };
  } catch (error) {
    if (enableServerLogs) {
      console.error("[dashboard] Failed to load data. Falling back to stub values.", error);
    }
    return {
      summary: buildFallbackSummary(month),
      transactions: buildFallbackTransactions(month),
    };
  }
}

async function safeJson(response: Response): Promise<string | null> {
  try {
    const payload = await response.json();
    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function buildFallbackSummary(month: string): AnalyticsSummary {
  const today = new Date();
  const cycleStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const cycleEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const toIso = (date: Date) => date.toISOString().slice(0, 10);
  return {
    month,
    totals: { income: 0, expense: 0, net: 0 },
    byCategory: [],
    topMerchants: [],
    anomalies: [],
    aiHighlight: {
      title: "Waiting for data",
      summary: "API data is not available yet. Once connected, highlights will appear here.",
      sentiment: "NEUTRAL",
      recommendations: ["Verify account connections", "Trigger a transaction sync"],
    },
    safeToSpend: {
      cycleStart: toIso(cycleStart),
      cycleEnd: toIso(cycleEnd),
      safeToSpendToday: 0,
      hardCap: 0,
      dailyBase: 0,
      dailyAdjusted: 0,
      rollToday: 0,
      paceRatio: 0,
      adjustmentFactor: 1,
      daysRemaining: Math.max(1, Math.ceil((cycleEnd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))),
      variableBudget: 0,
      variableSpent: 0,
      remainingVariableBudget: 0,
      danger: false,
      notes: ["Placeholder data is displayed because the API response is not configured."],
    },
    traceId: undefined,
  };
}

function buildFallbackTransactions(month: string): TransactionsList {
  return {
    month,
    period: {
      month,
      from: null,
      to: null,
    },
    transactions: [],
    aggregates: {
      incomeTotal: 0,
      expenseTotal: 0,
      netTotal: 0,
      monthNet: {},
      dayNet: {},
      categoryTotals: {},
      count: 0,
    },
    traceId: undefined,
  };
}
