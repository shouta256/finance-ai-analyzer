import { env } from "./env";

class LedgerApiError extends Error {
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

export async function ledgerFetch<T>(
  path: string,
  init: RequestInit & { traceId?: string; parseJson?: boolean } = {},
): Promise<T> {
  const traceId = init.traceId ?? crypto.randomUUID();
  const headers = new Headers(init.headers);
  headers.set("X-Request-Trace", traceId);
  // Preserve user context if middleware injected it
  const userId = (init.headers as Headers | Record<string, string> | undefined) instanceof Headers
    ? (init.headers as Headers).get("x-safepocket-user-id")
    : (init.headers as Record<string, string> | undefined)?.["x-safepocket-user-id"];
  if (userId && !headers.has("x-safepocket-user-id")) {
    headers.set("x-safepocket-user-id", userId);
  }
  if (!headers.has("content-type") && init.body) {
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
  const response = await fetch(`${env.LEDGER_SERVICE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers,
  });
  if (!response.ok) {
    throw await buildError(response);
  }
  if (init.parseJson === false || response.status === 204) {
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

export async function sendChatMessage(body: ChatRequestBody) {
  return await ledgerFetch<import("./schemas").ChatResponse>("/ai/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function fetchChatConversation(conversationId?: string) {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  return await ledgerFetch<import("./schemas").ChatResponse>(`/ai/chat${query}`);
}

async function buildError(response: Response) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = { error: { message: response.statusText } };
  }
  const message = (payload as { error?: { message?: string } })?.error?.message ?? "Ledger API error";
  return new LedgerApiError(message, response.status, payload);
}
