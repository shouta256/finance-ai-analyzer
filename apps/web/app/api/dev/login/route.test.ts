import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({
  ledgerFetch: vi.fn(),
}));

const mockedLedgerFetch = vi.mocked(ledgerFetch);

describe("/api/dev/login", () => {
  beforeEach(() => {
    mockedLedgerFetch.mockReset();
  });

  it("uses ledger service login and demo sync through ledgerFetch", async () => {
    mockedLedgerFetch
      .mockResolvedValueOnce({
        token: "backend-token",
        expiresInSeconds: 3600,
      })
      .mockResolvedValueOnce({
        status: "STARTED",
      });

    const request = {
      headers: new Headers(),
      nextUrl: new URL("https://example.com/api/dev/login?redirect=/dashboard"),
    } as any;

    const response = await GET(request);

    expect(response.status).toBe(303);
    expect(mockedLedgerFetch).toHaveBeenNthCalledWith(1, "/dev/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "0f08d2b9-28b3-4b28-bd33-41a36161e9ab" }),
      cache: "no-store",
      baseUrlOverride: undefined,
    });
    expect(mockedLedgerFetch).toHaveBeenNthCalledWith(2, "/transactions/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer backend-token",
      },
      body: JSON.stringify({ demoSeed: true }),
      cache: "no-store",
      baseUrlOverride: undefined,
    });
  });
});
