import { chatResponseSchema } from "./schemas";
import type { ChatResponse } from "./schemas";
import { LedgerApiError } from "./api-client";

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
        // Ignore previous failure so retries can proceed.
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

export async function fetchChatConversation(
  conversationId?: string,
  options?: { forceRefresh?: boolean },
): Promise<ChatResponse> {
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
    const message =
      (payload as { error?: { message?: string } })?.error?.message ??
      res.statusText ??
      "Chat API error";
    throw new LedgerApiError(message, res.status, payload);
  }
  return chatResponseSchema.parse(payload);
}
