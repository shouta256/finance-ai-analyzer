import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_TRANSACTIONS_PAGE_SIZE } from "@/src/lib/dashboard-constants";
import { DashboardClient } from "./dashboard";

const getAnalyticsSummaryMock = vi.fn();
const queryTransactionsMock = vi.fn();

vi.mock("react-chartjs-2", () => ({
  Doughnut: () => <div data-testid="chart-doughnut" />,
  Line: () => <div data-testid="chart-line" />,
}));

vi.mock("@/src/lib/client-api", () => ({
  getAnalyticsSummary: (...args: unknown[]) => getAnalyticsSummaryMock(...args),
  queryTransactions: (...args: unknown[]) => queryTransactionsMock(...args),
  triggerTransactionSync: vi.fn(),
  createPlaidLinkToken: vi.fn(),
  exchangePlaidPublicToken: vi.fn(),
  resetTransactions: vi.fn(),
}));

const originalFetch = global.fetch;

function createSummary() {
  return {
    month: "2024-03",
    totals: { income: 4200, expense: -188.65, net: 4011.35 },
    byCategory: [{ category: "Groceries", amount: -120.45, percentage: 64 }],
    topMerchants: [{ merchant: "Top Merchant", amount: -120.45, transactionCount: 1 }],
    anomalies: [],
    aiHighlight: {
      title: "Monthly financial health",
      summary: "Income $4200 vs spend $188.65.",
      sentiment: "POSITIVE" as const,
      recommendations: ["Save"],
    },
    latestHighlight: {
      month: "2024-03",
      highlight: {
        title: "Monthly financial health",
        summary: "Income $4200 vs spend $188.65.",
        sentiment: "POSITIVE" as const,
        recommendations: ["Save"],
      },
    },
    safeToSpend: {
      cycleStart: "2024-03-01",
      cycleEnd: "2024-03-31",
      safeToSpendToday: 100,
      hardCap: 500,
      dailyBase: 50,
      dailyAdjusted: 50,
      rollToday: 100,
      paceRatio: 1,
      adjustmentFactor: 1,
      daysRemaining: 28,
      variableBudget: 200,
      variableSpent: 0,
      remainingVariableBudget: 200,
      danger: false,
      notes: [],
    },
    traceId: "trace",
  };
}

function createTransactions(page: number, merchants: string[], total = merchants.length) {
  return {
    month: "2024-03",
    page,
    pageSize: merchants.length,
    total,
    transactions: merchants.map((merchantName, index) => ({
      id: `00000000-0000-4000-8000-${String(page * 100 + index).padStart(12, "0")}`,
      userId: "76a8d7e8-46a6-4c0a-9d5c-99dd8f2b617f",
      accountId: "d21be776-75ea-4a03-82bb-0353d363df38",
      merchantName,
      amount: -20.5 - index,
      currency: "USD",
      occurredAt: `2024-03-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      authorizedAt: `2024-03-${String((index % 28) + 1).padStart(2, "0")}T11:00:00Z`,
      pending: false,
      category: "Shopping",
      description: merchantName,
      anomalyScore: null,
      notes: null,
    })),
    aggregates: {
      incomeTotal: 4200,
      expenseTotal: -188.65,
      netTotal: 4011.35,
      monthNet: { "2024-03": 4011.35 },
      trendSeries: [{ period: "2024-03", net: 4011.35 }],
      trendGranularity: "MONTH" as const,
      categoryTotals: { Shopping: -188.65 },
      count: total,
    },
    traceId: "trace",
  };
}

describe("DashboardClient", () => {
  beforeEach(() => {
    getAnalyticsSummaryMock.mockReset();
    queryTransactionsMock.mockReset();
    getAnalyticsSummaryMock.mockResolvedValue(createSummary());
    queryTransactionsMock.mockImplementation(async ({ page }: { page?: number }) => {
      if (page === 1) {
        return createTransactions(1, ["Transaction 11", "Transaction 12"], 12);
      }
      return createTransactions(
        0,
        Array.from({ length: DASHBOARD_TRANSACTIONS_PAGE_SIZE }, (_, index) => `Transaction ${index + 1}`),
        12,
      );
    });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders summary tiles", async () => {
    render(
      <DashboardClient
        month="2024-03"
        initialSummary={createSummary()}
        initialTransactions={createTransactions(0, ["Transaction 1"])}
      />,
    );

    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(await screen.findByText("Transaction 1")).toBeInTheDocument();
  });

  it("changes transaction pages when Next and Previous are clicked", async () => {
    const user = userEvent.setup();

    render(
      <DashboardClient
        month="2024-03"
        initialSummary={createSummary()}
        initialTransactions={createTransactions(
          0,
          Array.from({ length: DASHBOARD_TRANSACTIONS_PAGE_SIZE }, (_, index) => `Transaction ${index + 1}`),
          12,
        )}
      />,
    );

    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Transaction 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(queryTransactionsMock).toHaveBeenCalledWith({
        month: "2024-03",
        from: undefined,
        to: undefined,
        page: 1,
        pageSize: DASHBOARD_TRANSACTIONS_PAGE_SIZE,
      });
    });
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Transaction 11")).toBeInTheDocument();
    expect(screen.queryByText("Transaction 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Transaction 1")).toBeInTheDocument();
  });
});
