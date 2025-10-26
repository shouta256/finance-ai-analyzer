import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/src/lib/api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/src/lib/api-client");
  return {
    ...actual,
    ledgerFetch: vi.fn(),
  };
});
import { POST } from "./route";
import { ledgerFetch, LedgerApiError } from "@/src/lib/api-client";
const mocked = vi.mocked(ledgerFetch);

describe("/api/plaid/link-token", () => {
  beforeEach(() => {
    mocked.mockReset();
  });

  it("returns 401 without auth", async () => {
    const res = await POST({ headers: new Headers(), url: "https://x" } as any);
    expect(res.status).toBe(401);
  });

  it("proxies success", async () => {
    mocked.mockResolvedValue({ linkToken: "lt", expiration: new Date().toISOString(), requestId: "req" });
    const res = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x" } as any);
    expect(res.status).toBe(200);
  });

  it.skip("maps backend error", async () => {
    const err = new LedgerApiError("Forbidden", 403, { error: { code: "FORBIDDEN", message: "no", traceId: "trace123" } });
    mocked.mockRejectedValue(err);
    const response = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x" } as any);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("PLAID_LINK_TOKEN_FAILED");
  });
});
