import { headers, cookies } from "next/headers";
import { z } from "zod";
import { analyticsSummarySchema, transactionsListSchema } from "./schemas";

export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;
export type TransactionsList = z.infer<typeof transactionsListSchema>;

export async function getDashboardData(month: string): Promise<{
  summary: AnalyticsSummary;
  transactions: TransactionsList;
}> {
  const headerList = headers();
  const cookieStore = cookies();
  const token = cookieStore.get("sp_token")?.value;
  if (!token) throw new Error("Missing authentication token (sp_token)");
  const cookieHeader = cookieStore
    .getAll()
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  const host = headerList.get("host") ?? "localhost:3000";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? `${protocol}://${host}`;
  const commonHeaders = new Headers();
  if (cookieHeader) {
    commonHeaders.set("cookie", cookieHeader);
  }
  commonHeaders.set("authorization", `Bearer ${token}`);

  const summaryUrl = new URL(`/api/analytics/summary?month=${month}`, baseUrl);
  const summaryResponse = await fetch(summaryUrl, {
    headers: commonHeaders,
    cache: "no-store",
  });
  if (!summaryResponse.ok) {
    const details = await safeJson(summaryResponse);
    throw new Error(details ?? `Failed to load analytics: ${summaryResponse.statusText}`);
  }
  const summaryJson = await summaryResponse.json();
  const summary = analyticsSummarySchema.parse(summaryJson);

  const transactionsUrl = new URL(`/api/transactions?month=${month}`, baseUrl);
  const transactionsResponse = await fetch(transactionsUrl, {
    headers: commonHeaders,
    cache: "no-store",
  });
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
