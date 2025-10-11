'use client';

import { useMemo, useState, useTransition } from "react";
import { formatCurrency, formatDateTime, formatPercent } from "@/src/lib/date";
import type { AnalyticsSummary, TransactionsList } from "@/src/lib/dashboard-data";
import {
  getAnalyticsSummary,
  listTransactions,
  triggerTransactionSync,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
} from "@/src/lib/client-api";
import { loadPlaidLink } from "@/src/lib/plaid";

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
  const [aiReady, setAiReady] = useState<boolean>(false);
  const [errorState, setErrorState] = useState<{ code: string; traceId?: string; details?: string } | null>(null);
  const [linking, setLinking] = useState<boolean>(false);

  const anomalies = state.summary.anomalies;
  const net = useMemo(() => state.summary.totals.net, [state.summary.totals.net]);
  const sentimentTone = useMemo(() => state.summary.aiHighlight.sentiment, [state.summary.aiHighlight.sentiment]);

  async function handleSync() {
    startTransition(async () => {
      try {
        await triggerTransactionSync();
        await refreshData();
        setMessage("Sync triggered successfully");
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "Sync failed");
      }
    });
  }

  async function handleLink() {
    if (linking) return;
    setErrorState(null);
    setMessage(null);
    setLinking(true);
    try {
      const token = await createPlaidLinkToken();
      setMessage("Opening Plaid Link...");
      let plaid: ReturnType<typeof loadPlaidLink> extends Promise<infer X> ? X : never;
      try {
        plaid = await loadPlaidLink();
      } catch (e) {
        // One retry with longer timeout in case of transient CDN/network delays
        console.warn("Plaid load failed; retrying with extended timeout", e);
        plaid = await loadPlaidLink(45000);
      }
      const handler = plaid.create({
        token: token.linkToken,
        onSuccess: async (publicToken) => {
          try {
            setMessage("Link successful. Finalizing...");
            await exchangePlaidPublicToken(publicToken);
            setMessage("Account linked. Syncing transactions...");
            await triggerTransactionSync();
            await refreshData();
            setMessage("Plaid account linked and sync triggered");
          } catch (error) {
            console.error(error);
            setMessage((error as Error).message ?? "Failed to finalize Plaid link");
          } finally {
            handler.destroy?.();
            setLinking(false);
          }
        },
        onExit: (err) => {
          if (err?.display_message) {
            setMessage(err.display_message);
          } else if (err?.error_code) {
            setMessage(`Plaid Link closed (${err.error_code})`);
          } else {
            setMessage("Plaid Link closed");
          }
          handler.destroy?.();
          setLinking(false);
        },
        onEvent: (eventName, metadata) => {
          if (eventName === "ERROR") {
            console.error("[PlaidLink] error", metadata);
            const code = (metadata as any)?.error_code || (metadata as any)?.status || "UNKNOWN";
            const msg = (metadata as any)?.error_message || (metadata as any)?.message || "Plaid initialization failed";
            setMessage(`Plaid error (${code}): ${msg}`);
          }
        },
      });
      handler.open();
    } catch (error) {
      console.error(error);
      setMessage((error as Error).message ?? "Unable to start Plaid Link");
      setLinking(false);
    }
  }

  async function refreshData() {
    try {
      setErrorState(null);
      const [summary, transactions] = await Promise.all([
        getAnalyticsSummary(month),
        listTransactions(month),
      ]);
      setState({ summary, transactions });
    } catch (e) {
      const err = e as any;
      // Map backend-shaped payload (ANALYTICS_FETCH_FAILED -> 502 with backendPayload)
      const payload = err?.payload?.error?.backendPayload?.error || err?.payload?.error || {};
      const code = payload.code || err?.payload?.error?.code || 'UNKNOWN_ERROR';
      const traceId = payload.traceId || err?.payload?.error?.traceId;
      const reason = payload.details?.reason || payload.message || err.message;
      // One automatic retry for transient DB issues
      if (code === 'DB_UNAVAILABLE' || reason?.includes('Failed to obtain JDBC Connection')) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          const [summary2, transactions2] = await Promise.all([
            getAnalyticsSummary(month),
            listTransactions(month),
          ]);
          setState({ summary: summary2, transactions: transactions2 });
          return;
        } catch {/* fall through to show error */}
      }
      setErrorState({ code, traceId, details: reason });
    }
  }

  async function handleGenerateAi() {
    startTransition(async () => {
      try {
        const summary = await getAnalyticsSummary(month, { generateAi: true });
        setState((prev) => ({ ...prev, summary }));
        setAiReady(true);
        setMessage("AI summary generated");
      } catch (err) {
        console.error(err);
        setMessage((err as Error).message ?? "AI summary failed");
      }
    });
  }

  const expenseCategories = useMemo(() => state.summary.byCategory, [state.summary.byCategory]);
  const topMerchants = useMemo(() => state.summary.topMerchants, [state.summary.topMerchants]);
  const topCategory = expenseCategories[0];
  const topMerchant = topMerchants[0];

  return (
    <div className="flex flex-col gap-6">
      {errorState ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 flex flex-col gap-2">
          <div className="font-semibold">{friendlyTitle(errorState.code)}</div>
          <div>{friendlyBody(errorState)}</div>
          {errorState.traceId ? (
            <div className="text-xs text-amber-600">Trace ID: {errorState.traceId}</div>
          ) : null}
          <div className="flex gap-2">
            <button
              onClick={() => { startTransition(() => refreshData()); }}
              disabled={isPending}
              className="rounded bg-amber-600 px-3 py-1 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50"
            >Retry</button>
            <button
              onClick={() => setErrorState(null)}
              className="rounded bg-white border border-amber-400 px-3 py-1 text-amber-700 text-xs font-medium hover:bg-amber-100"
            >Dismiss</button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleLink}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:opacity-50"
          disabled={isPending || linking}
        >
          Link Accounts with Plaid
        </button>
        <button
          onClick={handleSync}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-100"
          disabled={isPending}
        >
          Sync Transactions
        </button>
        <button
          onClick={handleGenerateAi}
          className="rounded-md border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
          disabled={isPending}
        >
          Generate AI Summary
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
        {!aiReady ? (
          <p className="mt-2 text-sm text-slate-500">Click &quot;Generate AI Summary&quot; to create an AI highlight for {month}.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="text-sm text-slate-500">{state.summary.aiHighlight.title}</p>
              <SentimentBadge sentiment={sentimentTone} />
            </div>
            <p className="mt-3 text-sm text-slate-700">{state.summary.aiHighlight.summary}</p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 text-xs text-slate-600">
              <li className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">Net this month: <span className="font-medium">{formatCurrency(net)}</span></li>
              <li className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">Anomaly alerts: <span className="font-medium">{anomalies.length}</span></li>
              {topCategory ? (
                <li className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">Top category: <span className="font-medium">{topCategory.category}</span> · {formatCurrency(topCategory.amount)}</li>
              ) : null}
              {topMerchant ? (
                <li className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">Top merchant: <span className="font-medium">{topMerchant.merchant}</span> · {formatCurrency(topMerchant.amount)}</li>
              ) : null}
            </ul>
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
          </>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Anomaly Alerts</h2>
        <p className="mb-3 text-sm text-slate-500">
          Highlighting spend spikes versus your usual pattern and monthly budget impact.
        </p>
        <div className="flow-root overflow-hidden rounded-lg border border-slate-100">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Diff vs Typical</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Budget Impact</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {anomalies.map((anomaly) => (
                <tr key={anomaly.transactionId} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">{anomaly.merchantName}</td>
                  <td className="px-4 py-2 text-slate-600">{formatCurrency(anomaly.amount)}</td>
                  <td className="px-4 py-2 text-slate-600">{formatCurrency(Math.abs(anomaly.deltaAmount))}</td>
                  <td className="px-4 py-2 text-slate-600">{formatPercent(anomaly.budgetImpactPercent / 100)}</td>
                  <td className="px-4 py-2 text-slate-600">{formatDateTime(anomaly.occurredAt)}</td>
                </tr>
              ))}
              {anomalies.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
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

function SentimentBadge({ sentiment }: { sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" }) {
  const styles: Record<typeof sentiment, string> = {
    POSITIVE: "bg-green-100 text-green-700 border-green-200",
    NEUTRAL: "bg-slate-100 text-slate-700 border-slate-200",
    NEGATIVE: "bg-rose-100 text-rose-700 border-rose-200",
  } as const;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${styles[sentiment]}`}>
      {sentiment}
    </span>
  );
}

function friendlyTitle(code: string): string {
  switch (code) {
    case 'DB_SCHEMA_MISSING':
      return 'Database schema missing';
    case 'DB_NOT_FOUND':
      return 'Database not initialized';
    case 'DB_UNAVAILABLE':
      return 'Database warming up';
    case 'ANALYTICS_FETCH_FAILED':
      return 'Analytics temporarily unavailable';
    case 'INTERNAL_ERROR':
      return 'Service error';
    default:
      return 'Unexpected issue';
  }
}

function friendlyBody(err: { code: string; traceId?: string; details?: string }): string {
  switch (err.code) {
    case 'DB_SCHEMA_MISSING':
      return 'The database exists but required tables are missing. An operator must run the schema bootstrap or migrations.';
    case 'DB_NOT_FOUND':
      return 'The configured database does not exist yet. An operator must create it (e.g. CREATE DATABASE safepocket). Once created, retry.';
    case 'DB_UNAVAILABLE':
      return 'The database connection was not ready. Retrying usually fixes this in a moment.';
    case 'ANALYTICS_FETCH_FAILED':
      return 'We could not fetch your analytics data. You can retry now or refresh later.';
    case 'INTERNAL_ERROR':
      return 'An internal error occurred. If this persists, contact support with the trace ID.';
    default:
      return err.details || 'An unknown error occurred.';
  }
}
