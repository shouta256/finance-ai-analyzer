import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { ledgerFetch, LedgerApiError } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/api-client")>();
  return { ...actual, ledgerFetch: vi.fn() };
});
const mocked = vi.mocked(ledgerFetch);

describe("/api/auth/token", () => {
  beforeEach(() => mocked.mockReset());

  it("validates payload (authorization_code requires code and redirectUri)", async () => {
    const res = await POST({
      url: "https://example.com/api/auth/token",
      json: async () => ({ grantType: "authorization_code" }),
    } as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("proxies success", async () => {
    const response = {
      accessToken: "at",
      idToken: "id",
      refreshToken: "rt",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: "openid",
      userId: "11111111-1111-1111-1111-111111111111",
      traceId: "trace-1",
    };
    mocked.mockResolvedValue(response);

    const res = await POST({
      url: "https://example.com/api/auth/token",
      json: async () => ({
        grantType: "authorization_code",
        code: "abc",
        redirectUri: "myapp://callback",
      }),
    } as any);

    expect(res.status).toBe(200);
    expect(mocked).toHaveBeenCalledWith("/auth/token", expect.objectContaining({ method: "POST" }));
    expect(await res.json()).toEqual(response);
  });

  it("validates payload (refresh_token requires refreshToken)", async () => {
    const res = await POST({
      url: "https://example.com/api/auth/token",
      json: async () => ({ grantType: "refresh_token" }),
    } as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});
