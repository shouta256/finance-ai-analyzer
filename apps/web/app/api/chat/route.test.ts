import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({
  ledgerFetch: vi.fn(),
}));

const mockedLedgerFetch = vi.mocked(ledgerFetch);

const sampleConversation = {
  conversationId: "11111111-1111-1111-1111-111111111111",
  messages: [],
  traceId: "trace-id",
};

describe("/api/chat route", () => {
  beforeEach(() => {
    mockedLedgerFetch.mockReset();
  });

  it("returns 401 for GET without authorization header", async () => {
    const request = {
      headers: new Headers(),
      url: "https://example.com/api/chat",
      cookies: new Map() as any,
    } as any;

    const res = await GET(request);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
  });

  it("accepts sp_token cookie when header missing", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleConversation);
    const request = {
      headers: new Headers(),
      url: "https://example.com/api/chat",
      cookies: {
        get: (name: string) => (name === "sp_token" ? { value: "cookie-token" } : undefined),
      },
      json: async () => ({ message: "Hello" }),
    } as any;

    const res = await POST(request);
    expect(res.status).toBe(200);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/ai/chat", {
      method: "POST",
      headers: { authorization: "Bearer cookie-token", "content-type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });
  });

  it("proxies GET requests to ledger service", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleConversation);
    const request = {
      headers: new Headers({ authorization: "Bearer token" }),
      url: "https://example.com/api/chat?conversationId=22222222-2222-2222-2222-222222222222",
      cookies: new Map() as any,
    } as any;

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(mockedLedgerFetch).toHaveBeenCalledWith(
      "/ai/chat?conversationId=22222222-2222-2222-2222-222222222222",
      { method: "GET", headers: { authorization: "Bearer token" } },
    );
    expect(await res.json()).toEqual(sampleConversation);
  });

  it("proxies POST requests to ledger service", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleConversation);
    const body = {
      conversationId: "33333333-3333-3333-3333-333333333333",
      message: "Hello",
      truncateFromMessageId: "44444444-4444-4444-4444-444444444444",
    };
    const request = {
      headers: new Headers({ authorization: "Bearer token" }),
      url: "https://example.com/api/chat",
      json: async () => body,
      cookies: new Map() as any,
    } as any;

    const res = await POST(request);
    expect(res.status).toBe(200);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/ai/chat", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(await res.json()).toEqual(sampleConversation);
  });

  it("returns 400 when payload fails validation", async () => {
    const request = {
      headers: new Headers({ authorization: "Bearer token" }),
      url: "https://example.com/api/chat",
      json: async () => ({ message: "" }),
      cookies: new Map() as any,
    } as any;

    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("String must contain at least 1 character") },
    });
    expect(mockedLedgerFetch).not.toHaveBeenCalled();
  });

  it("maps backend error status and payload", async () => {
    const err = Object.assign(new Error("Forbidden"), {
      status: 403,
      payload: { error: { code: "FORBIDDEN", message: "Forbidden request", traceId: "trace123" } },
    });
    mockedLedgerFetch.mockRejectedValue(err);

    const request = {
      headers: new Headers({ authorization: "Bearer token" }),
      url: "https://example.com/api/chat",
      json: async () => ({ message: "hello" }),
      cookies: new Map() as any,
    } as any;

    const res = await POST(request);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Forbidden request", traceId: "trace123" },
    });
  });
});
