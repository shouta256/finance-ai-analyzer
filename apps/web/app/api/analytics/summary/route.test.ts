import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { ledgerFetch } from "@/src/lib/api-client";

vi.mock("@/src/lib/api-client", () => ({
  ledgerFetch: vi.fn(),
}));

const mockedLedgerFetch = vi.mocked(ledgerFetch);

const sampleSummary = {
  month: "2026-04",
  totals: { income: 8400, expense: -3200, net: 5200 },
  byCategory: [],
  topMerchants: [],
  anomalies: [],
  aiHighlight: {
    title: "Monthly snapshot",
    summary: "Summary",
    sentiment: "NEUTRAL",
    recommendations: [],
  },
  latestHighlight: null,
  safeToSpend: {
    cycleStart: "2026-04-01",
    cycleEnd: "2026-04-30",
    safeToSpendToday: 0,
    hardCap: 0,
    dailyBase: 0,
    dailyAdjusted: 0,
    rollToday: 0,
    paceRatio: 0,
    adjustmentFactor: 1,
    daysRemaining: 24,
    variableBudget: 0,
    variableSpent: 0,
    remainingVariableBudget: 0,
    danger: false,
    notes: [],
  },
};

describe("/api/analytics/summary route", () => {
  beforeEach(() => {
    mockedLedgerFetch.mockReset();
  });

  it("returns 401 when no auth header or cookie present", async () => {
    const req = {
      headers: new Headers(),
      cookies: {
        get: () => undefined,
      },
      url: "https://example.com/api/analytics/summary?month=2026-04",
    } as any;

    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing authorization" } });
    expect(mockedLedgerFetch).not.toHaveBeenCalled();
  });

  it("allows fallback to sp_token cookie", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleSummary);
    const req = {
      headers: new Headers(),
      cookies: {
        get: (name: string) => (name === "sp_token" ? { value: "cookie-token" } : undefined),
      },
      url: "https://example.com/api/analytics/summary?month=2026-04",
    } as any;

    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/analytics/summary?month=2026-04", {
      method: "GET",
      headers: { authorization: "Bearer cookie-token" },
      baseUrlOverride: undefined,
    });
  });

  it("keeps existing bearer header", async () => {
    mockedLedgerFetch.mockResolvedValue(sampleSummary);
    const req = {
      headers: new Headers({ authorization: "Bearer header-token" }),
      cookies: {
        get: () => undefined,
      },
      url: "https://example.com/api/analytics/summary?month=2026-04&generateAi=true",
    } as any;

    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockedLedgerFetch).toHaveBeenCalledWith("/analytics/summary?month=2026-04&generateAi=true", {
      method: "GET",
      headers: { authorization: "Bearer header-token" },
      baseUrlOverride: undefined,
    });
  });
});
