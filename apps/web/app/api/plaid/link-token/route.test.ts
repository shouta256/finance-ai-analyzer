import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({ ledgerFetch: vi.fn() }));
const mocked = vi.mocked(ledgerFetch);

describe("/api/plaid/link-token", () => {
  beforeEach(() => mocked.mockReset());

  it("returns 401 without auth", async () => {
    const res = await POST({ headers: new Headers(), url: "https://x" } as any);
    expect(res.status).toBe(401);
  });

  it("proxies success", async () => {
    mocked.mockResolvedValue({ linkToken: "lt", expiration: new Date().toISOString(), requestId: "req" });
    const res = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x" } as any);
    expect(res.status).toBe(200);
  });

  it("maps backend error", async () => {
    mocked.mockRejectedValue({ status: 403, payload: { error: { code: "FORBIDDEN", message: "no" } } });
    const res = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x" } as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

