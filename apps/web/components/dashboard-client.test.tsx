import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { DashboardClient } from "./dashboard";

vi.mock("react-chartjs-2", () => ({
  Doughnut: () => <div data-testid="chart-doughnut" />,
  Line: () => <div data-testid="chart-line" />,
}));

describe("DashboardClient", () => {
  it("renders summary tiles", () => {
    const summary = {
      month: "2024-03",
      totals: { income: 4200, expense: -188.65, net: 4011.35 },
      byCategory: [{ category: "Groceries", amount: -120.45, percentage: 64 }],
      topMerchants: [{ merchant: "Amazon", amount: -120.45, transactionCount: 1 }],
      anomalies: [],
      aiHighlight: {
        title: "Monthly financial health",
        summary: "Income $4200 vs spend $188.65.",
        sentiment: "POSITIVE" as const,
        recommendations: ["Save"]
      },
      traceId: "trace",
    };
    const transactions = {
      month: "2024-03",
      transactions: [
        {
          id: "f4b90fb0-02b1-4e74-8c7d-f45e05c3bf2f",
          userId: "76a8d7e8-46a6-4c0a-9d5c-99dd8f2b617f",
          accountId: "d21be776-75ea-4a03-82bb-0353d363df38",
          merchantName: "Amazon",
          amount: -120.45,
          currency: "USD",
          occurredAt: "2024-03-10T12:00:00Z",
          authorizedAt: "2024-03-10T11:00:00Z",
          pending: false,
          category: "Shopping",
          description: "Amazon",
          anomalyScore: null,
          notes: null,
        },
      ],
      aggregates: {
        incomeTotal: 4200,
        expenseTotal: -188.65,
        netTotal: 4011.35,
        monthNet: { "2024-03": 4011.35 },
        categoryTotals: { Groceries: -120.45 },
      },
      traceId: "trace",
    };

    render(<DashboardClient month="2024-03" initialSummary={summary} initialTransactions={transactions} />);

    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Manage connections & sync")).toBeInTheDocument();
    expect(screen.getAllByText("Amazon").length).toBeGreaterThan(0);
  });
});
