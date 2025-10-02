"use client";

import { useMemo, useState, useTransition } from "react";
import { formatCurrency, formatDateTime } from "@/src/lib/date";
import type { AnalyticsSummary, TransactionsList } from "@/src/lib/dashboard-data";
import { analyticsSummarySchema, transactionsListSchema } from "@/src/lib/schemas";

interface DashboardClientProps {
  month: string;
  initialSummary: AnalyticsSummary;
  initialTransactions: TransactionsList;
}

interface FetchState {
  summary: AnalyticsSummary;
  transactions: TransactionsList;
}

export function DashboardClient({ month, initialSummary, initialTransactions }: DashboardClientProps) {
  const [state, setState] = useState<FetchState>({ summary: initialSummary, transactions: initialTransactions });
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const anomalies = state.summary.anomalies;

  async function handleSync() {
    startTransition(async () => {
      try {
        const syncResponse = await fetch("/api/transactions/sync", {
          method: "POST",
        });
        if (!syncResponse.ok) {
          throw new Error("Failed to trigger sync");
        }
        await refreshData();
        setMessage("Sync triggered successfully");
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "Sync failed");
      }
    });
  }

  async function handleLink() {
    startTransition(async () => {
      try {
        const linkResponse = await fetch("/api/plaid/link-token", { method: "POST" });
        if (!linkResponse.ok) {
          throw new Error("Failed to create link token");
        }
        const token = await linkResponse.json();
        setMessage(`Sandbox link token generated: ${token.linkToken}`);
      } catch (error) {
        setMessage((error as Error).message ?? "Unable to create link token");
      }
    });
  }

  async function refreshData() {
    const [summaryResponse, transactionsResponse] = await Promise.all([
      fetch(`/api/analytics/summary?month=${month}`),
      fetch(`/api/transactions?month=${month}`),
    ]);
    if (!summaryResponse.ok || !transactionsResponse.ok) {
      throw new Error("Refresh failed");
    }
    const [summaryJson, transactionsJson] = await Promise.all([summaryResponse.json(), transactionsResponse.json()]);
    const summary = analyticsSummarySchema.parse(summaryJson);
    const transactions = transactionsListSchema.parse(transactionsJson);
    setState({ summary, transactions });
  }

  const expenseCategories = useMemo(() => state.summary.byCategory, [state.summary.byCategory]);
  const topMerchants = useMemo(() => state.summary.topMerchants, [state.summary.topMerchants]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleLink}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700"
          disabled={isPending}
        >
          Generate Plaid Link Token
        </button>
        <button
          onClick={handleSync}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-100"
          disabled={isPending}
        >
          Sync Transactions
        </button>
        {message ? <span className="text-sm text-slate-600">{message}</span> : null}
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <SummaryCard title="Income" value={formatCurrency(state.summary.totals.income)} tone="positive" />
        <SummaryCard title="Expenses" value={formatCurrency(state.summary.totals.expense)} tone="negative" />
        <SummaryCard title="Net" value={formatCurrency(state.summary.totals.net)} tone="neutral" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Spend by Category</h2>
          <p className="mb-3 text-sm text-slate-500">Top categories for {month}.</p>
          <ul className="space-y-2">
            {expenseCategories.map((category) => (
              <li key={category.category} className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{category.category}</span>
                <span className="text-slate-600">
                  {formatCurrency(category.amount)} · {category.percentage.toFixed(1)}%
                </span>
              </li>
            ))}
            {expenseCategories.length === 0 ? <p className="text-sm text-slate-500">No expense activity.</p> : null}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold">Top Merchants</h2>
          <p className="mb-3 text-sm text-slate-500">Highest activity merchants.</p>
          <ul className="space-y-2">
            {topMerchants.map((merchant) => (
              <li key={merchant.merchant} className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{merchant.merchant}</span>
                <span className="text-slate-600">
                  {formatCurrency(merchant.amount)} · {merchant.transactionCount} tx
                </span>
              </li>
            ))}
            {topMerchants.length === 0 ? <p className="text-sm text-slate-500">No merchant activity.</p> : null}
          </ul>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">AI Monthly Highlight</h2>
        <p className="text-sm text-slate-500">{state.summary.aiHighlight.title}</p>
        <p className="mt-3 text-sm text-slate-700">{state.summary.aiHighlight.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
          {state.summary.aiHighlight.recommendations.map((recommendation) => (
            <span
              key={recommendation}
              className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600"
            >
              {recommendation}
            </span>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Anomaly Alerts</h2>
        <p className="mb-3 text-sm text-slate-500">
          Monitoring spend spikes using z-score and IQR detection.
        </p>
        <div className="flow-root overflow-hidden rounded-lg border border-slate-100">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Score</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {anomalies.map((anomaly) => (
                <tr key={anomaly.transactionId} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">{anomaly.merchantName}</td>
                  <td className="px-4 py-2 text-slate-600">{formatCurrency(anomaly.amount)}</td>
                  <td className="px-4 py-2 text-slate-600">{anomaly.method} · {anomaly.score.toFixed(2)}</td>
                  <td className="px-4 py-2 text-slate-600">{formatDateTime(anomaly.occurredAt)}</td>
                </tr>
              ))}
              {anomalies.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
                    No anomalies detected this month.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Recent Transactions</h2>
        <p className="mb-3 text-sm text-slate-500">Last synced transactions ordered by activity.</p>
        <div className="flow-root overflow-hidden rounded-lg border border-slate-100">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Category</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.transactions.transactions.map((transaction) => (
                <tr key={transaction.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">
                    <div className="font-medium">{transaction.merchantName}</div>
                    <div className="text-xs text-slate-500">{formatDateTime(transaction.occurredAt)}</div>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{transaction.category}</td>
                  <td className="px-4 py-2 text-slate-600">{formatCurrency(transaction.amount)}</td>
                  <td className="px-4 py-2 text-slate-600">{transaction.pending ? "Pending" : "Posted"}</td>
                </tr>
              ))}
              {state.transactions.transactions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
                    No transactions yet. Run a sync to fetch activity.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}

function SummaryCard({ title, value, tone }: SummaryCardProps) {
  const toneStyles: Record<SummaryCardProps["tone"], string> = {
    positive: "border-green-200 bg-green-50 text-green-700",
    negative: "border-rose-200 bg-rose-50 text-rose-700",
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
  };
  return (
    <div className={`rounded-xl border ${toneStyles[tone]} p-4 shadow-sm`}>
      <p className="text-sm font-medium uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
