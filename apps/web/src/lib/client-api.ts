import { z } from "zod";
import { analyticsSummarySchema, plaidExchangeSchema, plaidLinkTokenSchema, transactionsListSchema, ragAggregateResponseSchema, ragSearchResponseSchema, ragSummariesResponseSchema, transactionsResetResponseSchema } from "./schemas";
import { getStoredAccessToken } from "./auth-storage";
const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, "") || "";

function buildRequestUrl(path: string, params?: Record<string, string | undefined>): string {
  let targetPath = path.startsWith("/") ? path : `/${path}`;
  if (API_BASE && targetPath.startsWith("/api/")) {
    targetPath = targetPath.replace(/^\/api\//, "/");
  }
  let target: string;
  if (API_BASE) {
    target = `${API_BASE}${targetPath}`;
  } else if (typeof window !== "undefined") {
    const url = new URL(targetPath, window.location.origin);
    target = url.toString();
  } else {
    target = targetPath;
  }
  if (params) {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
  return target;
}

function withCredentials(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers ?? undefined);
  if (typeof window !== "undefined") {
    const token = getStoredAccessToken();
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
  }
  return {
    ...init,
    credentials: init.credentials ?? "include",
    headers,
  };
}


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
  const url = buildRequestUrl("/api/analytics/summary", { month, generateAi: options?.generateAi ? "true" : undefined });
  if (process.env.NEXT_PUBLIC_DEBUG_API === 'true') {
    console.debug('[client-api] getAnalyticsSummary ->', url);
  }
  const res = await fetch(url, withCredentials({ cache: "no-store" }));
  return handleJson(res, analyticsSummarySchema);
}

export async function listTransactions(month: string): Promise<TransactionsList> {
  const url = buildRequestUrl("/api/transactions", { month });
  const res = await fetch(url, withCredentials({ cache: "no-store" }));
  return handleJson(res, transactionsListSchema);
}

export interface TransactionsQuery {
  month?: string;
  from?: string;
  to?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}

export async function queryTransactions(params: TransactionsQuery = {}): Promise<TransactionsList> {
  const url = buildRequestUrl("/api/transactions", {
    month: params.month,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    page: params.page !== undefined ? String(params.page) : undefined,
    pageSize: params.pageSize !== undefined ? String(params.pageSize) : undefined,
  });
  const res = await fetch(url, withCredentials({ cache: "no-store" }));
  return handleJson(res, transactionsListSchema);
}

// from/to expect YYYY-MM boundaries; month remains YYYY-MM for single-month view.
export async function listTransactionsRange(params: { from?: string; to?: string; month?: string }): Promise<TransactionsList> {
  const url = buildRequestUrl("/api/transactions", { month: params.month, from: params.from, to: params.to });
  const res = await fetch(url, withCredentials({ cache: "no-store" }));
  return handleJson(res, transactionsListSchema);
}

export interface TriggerSyncOptions {
  forceFullSync?: boolean;
  demoSeed?: boolean;
  startMonth?: string; // YYYY-MM
}

export async function triggerTransactionSync(options: TriggerSyncOptions = {}): Promise<void> {
  const body = Object.keys(options).length > 0 ? JSON.stringify(options) : undefined;
  const res = await fetch(buildRequestUrl("/api/transactions/sync"), withCredentials({
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  }));
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
  const res = await fetch(buildRequestUrl("/api/transactions/reset"), withCredentials({
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  }));
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
    const res = await fetch(buildRequestUrl("/api/plaid/link-token"), withCredentials({ method: "POST" }));
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
  const res = await fetch(buildRequestUrl("/api/plaid/exchange"), withCredentials({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicToken }),
  }));
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
  const res = await fetch(buildRequestUrl("/api/rag/search"), withCredentials({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  }));
  return handleJson(res, ragSearchResponseSchema);
}

export async function ragSummaries(month: string) {
  const url = buildRequestUrl("/api/rag/summaries", { month });
  const res = await fetch(url, withCredentials({ cache: "no-store" }));
  return handleJson(res, ragSummariesResponseSchema);
}

export async function ragAggregate(body: { from?: string; to?: string; granularity: "category" | "merchant" | "month"; }) {
  const res = await fetch(buildRequestUrl("/api/rag/aggregate"), withCredentials({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return handleJson(res, ragAggregateResponseSchema);
}
