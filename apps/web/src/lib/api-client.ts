import { env } from "./env";
import { chatResponseSchema } from "./schemas";

export class LedgerApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

const defaultHeaders = {
  "content-type": "application/json",
};

type LedgerFetchInit = RequestInit & {
  traceId?: string;
  parseJson?: boolean;
  baseUrlOverride?: string;
};

export async function ledgerFetch<T>(
  path: string,
  init: LedgerFetchInit = {},
): Promise<T> {
  const {
    traceId = crypto.randomUUID(),
    parseJson = true,
    baseUrlOverride,
    ...fetchInit
  } = init;
  const headers = new Headers(fetchInit.headers);
  headers.set("X-Request-Trace", traceId);
  // Preserve user context if middleware injected it
  const userId = (fetchInit.headers as Headers | Record<string, string> | undefined) instanceof Headers
    ? (fetchInit.headers as Headers).get("x-safepocket-user-id")
    : (fetchInit.headers as Record<string, string> | undefined)?.["x-safepocket-user-id"];
  if (userId && !headers.has("x-safepocket-user-id")) {
    headers.set("x-safepocket-user-id", userId);
  }
  if (!headers.has("content-type") && fetchInit.body) {
    headers.set("content-type", defaultHeaders["content-type"]);
  }
  // Auto-inject Authorization from sp_token cookie if not already present (server-side only)
  if (!headers.has("authorization")) {
    try {
      // Dynamically import next/headers only in server runtime
      const mod = await import("next/headers");
      const token = mod.cookies().get("sp_token")?.value;
      if (token) headers.set("authorization", `Bearer ${token}`);
    } catch {
      // ignore if not in a Next.js server context
    }
  }
  const base = baseUrlOverride ?? env.LEDGER_SERVICE_URL;
  const prefix = baseUrlOverride ? '' : (env as any).LEDGER_SERVICE_PATH_PREFIX || '';
  const response = await fetch(`${base}${prefix}${path}`, {
    credentials: 'include',
    ...fetchInit,
    headers,
  });
  if (!response.ok) {
    throw await buildError(response);
  }
  if (parseJson === false || response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// Chat API helper
export interface ChatRequestBody {
  conversationId?: string;
  message: string;
  truncateFromMessageId?: string;
}

export async function sendChatMessage(body: ChatRequestBody): Promise<import("./schemas").ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return await parseChatResponse(res);
}

export async function fetchChatConversation(conversationId?: string): Promise<import("./schemas").ChatResponse> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const res = await fetch(`/api/chat${query}`, { cache: "no-store" });
  return await parseChatResponse(res);
}

async function parseChatResponse(res: Response): Promise<import("./schemas").ChatResponse> {
  const text = await res.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }
  if (!res.ok) {
    const message = (payload as { error?: { message?: string } })?.error?.message ?? res.statusText ?? "Chat API error";
    throw new LedgerApiError(message, res.status, payload);
  }
  return chatResponseSchema.parse(payload);
}

function pickFirstMessage(...candidates: Array<unknown>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

async function buildError(response: Response) {
  let text: string | undefined;
  try {
    text = await response.text();
  } catch {
    text = undefined;
  }

  let payload: unknown = undefined;
  if (text && text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  const errorNode =
    payload && typeof payload === "object"
      ? (payload as { error?: unknown }).error
      : undefined;
  const errorNodeObj = typeof errorNode === "object" && errorNode !== null ? (errorNode as Record<string, unknown>) : undefined;

  const message =
    pickFirstMessage(
      errorNodeObj?.message,
      errorNodeObj?.error_description,
      errorNodeObj?.description,
      typeof errorNode === "string" ? errorNode : undefined,
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).error_description
        : undefined,
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).description
        : undefined,
      payload && typeof payload === "object" ? (payload as Record<string, unknown>).message : undefined,
      typeof payload === "string" ? payload : undefined,
      response.statusText,
      text,
    ) ?? "Ledger API error";

  return new LedgerApiError(message, response.status, payload ?? text);
}
