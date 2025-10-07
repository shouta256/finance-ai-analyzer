import { z } from "zod";
import { analyticsSummarySchema, transactionsListSchema } from "./schemas";

export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;
export type TransactionsList = z.infer<typeof transactionsListSchema>;

class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

const plaidLinkTokenSchema = z.object({ linkToken: z.string() });

async function handleJson<T>(res: Response, schema: z.ZodSchema<T>): Promise<T> {
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    const message = (payload as { error?: { message?: string } })?.error?.message ?? res.statusText;
    throw new ApiError(message || "Request failed", res.status, payload);
  }
  const data = await res.json();
  return schema.parse(data);
}

export async function getAnalyticsSummary(month: string, options?: { generateAi?: boolean }): Promise<AnalyticsSummary> {
  const url = new URL(`/api/analytics/summary`, window.location.origin);
  url.searchParams.set("month", month);
  if (options?.generateAi) url.searchParams.set("generateAi", "true");
  if (process.env.NEXT_PUBLIC_DEBUG_API === 'true') {
    // eslint-disable-next-line no-console
    console.debug('[client-api] getAnalyticsSummary ->', url.toString());
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  return handleJson(res, analyticsSummarySchema);
}

export async function listTransactions(month: string): Promise<TransactionsList> {
  const url = new URL(`/api/transactions`, window.location.origin);
  url.searchParams.set("month", month);
  const res = await fetch(url.toString(), { cache: "no-store" });
  return handleJson(res, transactionsListSchema);
}

export async function triggerTransactionSync(): Promise<void> {
  const res = await fetch(`/api/transactions/sync`, { method: "POST" });
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    const message = (payload as { error?: { message?: string } })?.error?.message ?? res.statusText;
    throw new ApiError(message || "Failed to trigger sync", res.status, payload);
  }
}

export async function createPlaidLinkToken(): Promise<{ linkToken: string }> {
  const res = await fetch(`/api/plaid/link-token`, { method: "POST" });
  return handleJson(res, plaidLinkTokenSchema);
}
