import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({
  ledgerFetch: vi.fn(),
}));

const mockedLedgerFetch = vi.mocked(ledgerFetch);

const sampleResponse = {
  status: "STARTED",
  syncedCount: 3,
  pendingCount: 0,
  traceId: "trace-123",
};

describe("/api/transactions/sync route", () => {
  beforeEach(() => {
    mockedLedgerFetch.mockReset();
  });

  it("returns 401 when no auth header or cookie present", async () => {
    const req = {
      headers: new Headers(),
      cookies: {
        get: () => undefined,
      },
      url: "https://example.com/api/transactions/sync",
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
    expect(mockedLedgerFetch).not.toHaveBeenCalled();
  });

  it("allows fallback to sp_token cookie", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleResponse);
    const headers = new Headers();
    headers.set("content-length", "1");
    const req = {
      headers,
      cookies: {
        get: (name: string) => (name === "sp_token" ? { value: "cookie-token" } : undefined),
      },
      json: async () => ({ forceFullSync: true }),
      url: "https://example.com/api/transactions/sync",
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/transactions/sync", {
      method: "POST",
      headers: { authorization: "Bearer cookie-token", "content-type": "application/json" },
      body: JSON.stringify({ forceFullSync: true }),
      baseUrlOverride: undefined,
    });
    expect(await res.json()).toEqual(sampleResponse);
  });

  it("proxies when header already provided", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleResponse);
    const headers = new Headers({ authorization: "Bearer header-token" });
    const req = {
      headers,
      cookies: {
        get: () => undefined,
      },
      json: async () => undefined,
      url: "https://example.com/api/transactions/sync",
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/transactions/sync", {
      method: "POST",
      headers: { authorization: "Bearer header-token" },
      body: undefined,
      baseUrlOverride: undefined,
    });
    expect(await res.json()).toEqual(sampleResponse);
  });
});
