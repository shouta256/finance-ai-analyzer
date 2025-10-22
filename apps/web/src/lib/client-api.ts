import { z } from "zod";
import { analyticsSummarySchema, plaidExchangeSchema, plaidLinkTokenSchema, transactionsListSchema, ragAggregateResponseSchema, ragSearchResponseSchema, ragSummariesResponseSchema, transactionsResetResponseSchema } from "./schemas";

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

// from/to expect YYYY-MM boundaries; month remains YYYY-MM for single-month view.
export async function listTransactionsRange(params: { from?: string; to?: string; month?: string }): Promise<TransactionsList> {
  const url = new URL(`/api/transactions`, window.location.origin);
  if (params.month) url.searchParams.set("month", params.month);
  if (params.from) url.searchParams.set("from", params.from);
  if (params.to) url.searchParams.set("to", params.to);
  const res = await fetch(url.toString(), { cache: "no-store" });
  return handleJson(res, transactionsListSchema);
}

export interface TriggerSyncOptions {
  forceFullSync?: boolean;
  demoSeed?: boolean;
  startMonth?: string; // YYYY-MM
}

export async function triggerTransactionSync(options: TriggerSyncOptions = {}): Promise<void> {
  const body = Object.keys(options).length > 0 ? JSON.stringify(options) : undefined;
  const res = await fetch(`/api/transactions/sync`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  });
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

export async function resetTransactions(options: { unlinkPlaid?: boolean } = {}) {
  const body = Object.keys(options).length > 0 ? JSON.stringify(options) : undefined;
  const res = await fetch(`/api/transactions/reset`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  });
  const parsed = await (async () => {
    const json = await res.json().catch(() => null);
    return json;
  })();
  if (!res.ok) {
    const message = (parsed as any)?.error?.message ?? res.statusText;
    throw new ApiError(message || "Failed to reset transactions", res.status, parsed);
  }
  return transactionsResetResponseSchema.parse(parsed);
}

const TOKEN_REFRESH_BUFFER_MS = 30_000;
let plaidLinkTokenCache: { token: string; expiresAt: number } | null = null;
let plaidLinkTokenPending: Promise<{ linkToken: string; expiration: string; requestId?: string | null }> | null = null;

export async function createPlaidLinkToken(): Promise<{ linkToken: string }> {
  const now = Date.now();
  if (plaidLinkTokenCache && plaidLinkTokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
    return { linkToken: plaidLinkTokenCache.token };
  }
  if (plaidLinkTokenPending) {
    const pending = await plaidLinkTokenPending;
    return { linkToken: pending.linkToken };
  }
  plaidLinkTokenPending = (async () => {
    const res = await fetch(`/api/plaid/link-token`, { method: "POST" });
    const parsed = await handleJson(res, plaidLinkTokenSchema);
    const parsedExpiry = Date.parse(parsed.expiration);
    const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : now + 4 * 60 * 1000;
    plaidLinkTokenCache = { token: parsed.linkToken, expiresAt };
    return parsed;
  })();
  try {
    const parsed = await plaidLinkTokenPending;
    return { linkToken: parsed.linkToken };
  } finally {
    plaidLinkTokenPending = null;
  }
}

export async function exchangePlaidPublicToken(publicToken: string) {
  const res = await fetch(`/api/plaid/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicToken }),
  });
  return handleJson(res, plaidExchangeSchema);
}

// RAG client helpers
export interface RagSearchOptions {
  q?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  categories?: string[];
  amountMin?: number;
  amountMax?: number;
  topK?: number;
}

export async function ragSearch(options: RagSearchOptions) {
  const res = await fetch(`/api/rag/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  return handleJson(res, ragSearchResponseSchema);
}

export async function ragSummaries(month: string) {
  const url = new URL(`/api/rag/summaries`, window.location.origin);
  url.searchParams.set("month", month);
  const res = await fetch(url.toString(), { cache: "no-store" });
  return handleJson(res, ragSummariesResponseSchema);
}

export async function ragAggregate(body: { from?: string; to?: string; granularity: "category" | "merchant" | "month"; }) {
  const res = await fetch(`/api/rag/aggregate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleJson(res, ragAggregateResponseSchema);
}
