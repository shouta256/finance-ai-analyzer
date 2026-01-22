import { env } from "./env";
import { chatResponseSchema } from "./schemas";
import type { ChatResponse } from "./schemas";
import { getStoredAccessToken } from "./auth-storage";

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

function buildLedgerUrl(base: string, prefix: string, path: string): string {
  const sanitizedBase = base.replace(/\/+$/g, "");
  const normalizedPrefix = prefix ? `/${prefix.replace(/^\/+|\/+$/g, "")}` : "";
  
  // Split path and query string to preserve query parameters
  const [pathPart, queryPart] = path.split("?");
  const normalizedPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;

  try {
    const url = new URL(sanitizedBase);
    const basePath = url.pathname.replace(/\/+$/g, "");
    const prefixPath = normalizedPrefix.replace(/\/+$/g, "");
    const needsPrefix = prefixPath && !basePath.endsWith(prefixPath);
    const finalPrefix = needsPrefix ? normalizedPrefix : "";
    url.pathname = `${basePath}${finalPrefix}${normalizedPath}`.replace(/\/{2,}/g, "/");
    // Preserve query string from the path
    if (queryPart) {
      url.search = `?${queryPart}`;
    }
    return url.toString();
  } catch {
    // Fallback for non-URL-safe bases (should not happen in normal deployments)
    const needsPrefix = normalizedPrefix && !sanitizedBase.endsWith(normalizedPrefix);
    const finalPrefix = needsPrefix ? normalizedPrefix : "";
    const fullPath = `${sanitizedBase}${finalPrefix}${normalizedPath}`.replace(/\/{2,}/g, "/");
    return queryPart ? `${fullPath}?${queryPart}` : fullPath;
  }
}

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
    if (typeof window !== "undefined") {
      const token = getStoredAccessToken();
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
    } else {
      try {
        const mod = await import("next/headers");
        const token = mod.cookies().get("sp_token")?.value;
        if (token) headers.set("authorization", `Bearer ${token}`);
      } catch {
        // ignore if not in a Next.js server context
      }
    }
  }
  const base = baseUrlOverride ?? env.LEDGER_SERVICE_URL;
  const prefix = baseUrlOverride ? '' : (env as any).LEDGER_SERVICE_PATH_PREFIX || '';
  const targetUrl = buildLedgerUrl(base, prefix, path);
  const response = await fetch(targetUrl, {
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

const CHAT_CACHE_TTL_MS = 30_000;
const CHAT_LATEST_KEY = "__latest__";
const chatConversationCache = new Map<string, { expiresAt: number; data: ChatResponse }>();
const chatFetchInFlight = new Map<string, Promise<ChatResponse>>();
const chatSendInFlight = new Map<string, Promise<ChatResponse>>();

function cacheChatResponse(response: ChatResponse) {
  const expiresAt = Date.now() + CHAT_CACHE_TTL_MS;
  chatConversationCache.set(response.conversationId, { expiresAt, data: response });
  chatConversationCache.set(CHAT_LATEST_KEY, { expiresAt, data: response });
}

function getCachedConversation(conversationId?: string): ChatResponse | undefined {
  const key = conversationId ?? CHAT_LATEST_KEY;
  const cached = chatConversationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (cached) {
    chatConversationCache.delete(key);
  }
  return undefined;
}

function invalidateChatCache(conversationId?: string) {
  if (conversationId) {
    chatConversationCache.delete(conversationId);
    chatFetchInFlight.delete(conversationId);
  }
  chatConversationCache.delete(CHAT_LATEST_KEY);
  chatFetchInFlight.delete(CHAT_LATEST_KEY);
}

export async function sendChatMessage(body: ChatRequestBody): Promise<ChatResponse> {
  const queueKey = body.conversationId ?? CHAT_LATEST_KEY;
  const existing = chatSendInFlight.get(queueKey);
  const task = (async () => {
    if (existing) {
      try {
        await existing;
      } catch {
        // ignore previous failure so retries can proceed
      }
    }
    invalidateChatCache(body.conversationId);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const parsed = await parseChatResponse(res);
    cacheChatResponse(parsed);
    return parsed;
  })();
  chatSendInFlight.set(queueKey, task);
  return task.finally(() => {
    if (chatSendInFlight.get(queueKey) === task) {
      chatSendInFlight.delete(queueKey);
    }
  });
}

export async function fetchChatConversation(conversationId?: string, options?: { forceRefresh?: boolean }): Promise<ChatResponse> {
  const key = conversationId ?? CHAT_LATEST_KEY;
  if (!options?.forceRefresh) {
    const cached = getCachedConversation(conversationId);
    if (cached) {
      return cached;
    }
    const inFlight = chatFetchInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }
    const pending = (async () => {
      try {
        const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
        const res = await fetch(`/api/chat${query}`, { cache: "no-store" });
        const parsed = await parseChatResponse(res);
        cacheChatResponse(parsed);
        return parsed;
      } finally {
        chatFetchInFlight.delete(key);
      }
    })();
    chatFetchInFlight.set(key, pending);
    return pending;
  }
  invalidateChatCache(conversationId);
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  const res = await fetch(`/api/chat${query}`, { cache: "reload" });
  const parsed = await parseChatResponse(res);
  cacheChatResponse(parsed);
  return parsed;
}

async function parseChatResponse(res: Response): Promise<ChatResponse> {
  const textBody = await res.text();
  let payload: unknown = {};
  if (textBody) {
    try {
      payload = JSON.parse(textBody);
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
