import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({ ledgerFetch: vi.fn() }));
const mocked = vi.mocked(ledgerFetch);

describe("/api/plaid/exchange", () => {
  beforeEach(() => mocked.mockReset());

  it("returns 401 without auth", async () => {
    const res = await POST({ headers: new Headers(), url: "https://x", json: async () => ({}) } as any);
    expect(res.status).toBe(401);
  });

  it("validates payload", async () => {
    const res = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x", json: async () => ({}) } as any);
    expect(res.status).toBe(400);
  });

  it("proxies success", async () => {
    mocked.mockResolvedValue({ itemId: "it", status: "SUCCESS", requestId: "req" });
    const res = await POST({ headers: new Headers({ authorization: "Bearer t" }), url: "https://x", json: async () => ({ publicToken: "pub" }) } as any);
    expect(res.status).toBe(200);
  });
});

