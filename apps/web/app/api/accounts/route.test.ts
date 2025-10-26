import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";
import { NextResponse } from "next/server";

vi.mock("@/src/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/api-client")>();
  return { ...actual, ledgerFetch: vi.fn() };
});
const mocked = vi.mocked(ledgerFetch);

describe("/api/accounts route", () => {
  beforeEach(() => {
    mocked.mockReset();
  });

  it("returns 401 without authorization header", async () => {
    const req = { headers: new Headers(), url: "https://example.com/api/accounts" } as any;
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
  });

  it("proxies GET to ledger /accounts", async () => {
    const payload = {
      currency: "USD",
      totalBalance: 1000.0,
      accounts: [],
      traceId: "t",
    };
    mocked.mockResolvedValue(payload);

    const req = { headers: new Headers({ authorization: "Bearer token" }), url: "https://example.com/api/accounts" } as any;
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mocked).toHaveBeenCalledWith("/accounts", { method: "GET", headers: { authorization: "Bearer token" } });
    expect(await res.json()).toEqual(payload);
  });

  it.skip("maps backend error", async () => {
    const errRes = NextResponse.json({ error: { code: "FORBIDDEN", message: "Forbidden", traceId: "t" } }, { status: 403 });
    mocked.mockRejectedValue(errRes as any);
    const req = { headers: new Headers({ authorization: "Bearer token" }), url: "https://example.com/api/accounts" } as any;
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "Forbidden", traceId: "t" } });
  });
});
