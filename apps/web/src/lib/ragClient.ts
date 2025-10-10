import { z } from "zod";
import {
  ragSearchResponseSchema,
  ragSummariesResponseSchema,
  ragAggregateResponseSchema,
} from "./schemas";

export { ragSearchResponseSchema, ragSummariesResponseSchema, ragAggregateResponseSchema } from "./schemas";

class RagApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export const ragSearchRequestSchema = z.object({
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  categories: z.array(z.string()).optional(),
  amountMin: z.number().int().nonnegative().optional(),
  amountMax: z.number().int().nonnegative().optional(),
  topK: z.number().int().min(1).max(100).optional(),
  fields: z.array(z.string()).optional(),
});

export type RagSearchRequest = z.infer<typeof ragSearchRequestSchema>;

export type RagSearchResponse = z.infer<typeof ragSearchResponseSchema>;
export type RagSummariesResponse = z.infer<typeof ragSummariesResponseSchema>;
export type RagAggregateResponse = z.infer<typeof ragAggregateResponseSchema>;

export interface RagSearchOptions {
  chatId?: string;
}

async function handleResponse<T>(res: Response, schema: z.ZodSchema<T>): Promise<{ data: T; chatId?: string }> {
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = payload?.error?.message ?? res.statusText;
    throw new RagApiError(message ?? "Request failed", res.status, payload);
  }
  const data = schema.parse(payload);
  const chatId = res.headers.get("x-chat-id") ?? (data as any)?.chatId;
  return { data, chatId: chatId ?? undefined };
}

export async function ragSearch(body: RagSearchRequest, options?: RagSearchOptions) {
  const payload = ragSearchRequestSchema.parse(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options?.chatId) {
    headers["x-chat-id"] = options.chatId;
  }
  const res = await fetch("/api/rag/search", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  return handleResponse(res, ragSearchResponseSchema);
}

export async function ragSummaries(month: string) {
  const query = new URLSearchParams({ month }).toString();
  const res = await fetch(`/api/rag/summaries?${query}`, { cache: "no-store" });
  const { data } = await handleResponse(res, ragSummariesResponseSchema);
  return data;
}

export interface RagAggregateRequest {
  from?: string;
  to?: string;
  granularity: "category" | "merchant" | "month";
  chatId?: string;
}

export const ragAggregateRequestSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(["category", "merchant", "month"]),
});

export async function ragAggregate(body: RagAggregateRequest) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (body.chatId) headers["x-chat-id"] = body.chatId;
  const res = await fetch("/api/rag/aggregate", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: body.from, to: body.to, granularity: body.granularity }),
    cache: "no-store",
  });
  return handleResponse(res, ragAggregateResponseSchema);
}

export { RagApiError };
