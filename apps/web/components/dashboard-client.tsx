'use client';

import { useEffect, useMemo, useState, useTransition } from "react";
import { formatCurrency, formatDateTime, formatPercent } from "@/src/lib/date";
import type { AnalyticsSummary, TransactionsList } from "@/src/lib/dashboard-data";
import {
  getAnalyticsSummary,
  listTransactions,
  triggerTransactionSync,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  resetTransactions,
} from "@/src/lib/client-api";
import { loadPlaidLink } from "@/src/lib/plaid";
import { transactionsListSchema } from "@/src/lib/schemas";
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import { Doughnut, Line } from "react-chartjs-2";

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler);

interface DashboardClientProps {
  month: string;
  initialSummary: AnalyticsSummary;
  initialTransactions: TransactionsList;
}

interface FetchState {
  summary: AnalyticsSummary;
  transactions: TransactionsList;
}

type RangeMode = "month" | "all" | "custom";

const RANGE_SEGMENTS: Array<{ value: RangeMode; label: string }> = [
  { value: "month", label: "Single month" },
  { value: "all", label: "All history" },
  { value: "custom", label: "Custom range" },
];

const CACHE_TTL_MS = 3 * 60 * 1000;

type SummaryCacheEntry = { data: AnalyticsSummary; expires: number };
type TransactionsCacheEntry = { data: TransactionsList; expires: number };

const SUMMARY_CACHE = new Map<string, SummaryCacheEntry>();
const TRANSACTIONS_CACHE = new Map<string, TransactionsCacheEntry>();

const cacheKey = (parts: Record<string, unknown>) =>
  Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

function setSummaryCache(key: string, data: AnalyticsSummary) {
  SUMMARY_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function setTransactionsCache(key: string, data: TransactionsList) {
  TRANSACTIONS_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function clearDataCaches() {
  SUMMARY_CACHE.clear();
  TRANSACTIONS_CACHE.clear();
}

export function DashboardClient({ month, initialSummary, initialTransactions }: DashboardClientProps) {
  const [state, setState] = useState<FetchState>({ summary: initialSummary, transactions: initialTransactions });
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState<boolean>(false);
  const [errorState, setErrorState] = useState<{ code: string; traceId?: string; details?: string } | null>(null);
  const [linking, setLinking] = useState<boolean>(false);
  const [sandboxLoading, setSandboxLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [generatingAi, setGeneratingAi] = useState<boolean>(false);
  const [startMonth, setStartMonth] = useState<string>("");
  const [focusMonth, setFocusMonth] = useState<string>(month);
  const [rangeMode, setRangeMode] = useState<RangeMode>("month");
  const [customFromMonth, setCustomFromMonth] = useState<string>("");
  const [customToMonth, setCustomToMonth] = useState<string>("");
  const [page, setPage] = useState<number>(0);
  const pageSize = 15;
  const [unlinkPlaid, setUnlinkPlaid] = useState<boolean>(false);
  const [actionsOpen, setActionsOpen] = useState<boolean>(false);

  useEffect(() => {
    setFocusMonth(month);
  }, [month]);

  useEffect(() => {
    const summaryKey = cacheKey({ month });
    setSummaryCache(summaryKey, initialSummary);
    const transactionsKey = cacheKey({ mode: "month", month, page: 0, size: pageSize });
    setTransactionsCache(transactionsKey, initialTransactions);
  }, [initialSummary, initialTransactions, month, pageSize]);

  const expenseCategories = useMemo(() => state.summary.byCategory, [state.summary.byCategory]);
  const topMerchants = useMemo(() => state.summary.topMerchants, [state.summary.topMerchants]);
  const anomalies = useMemo(() => state.summary.anomalies, [state.summary.anomalies]);
  const topCategory = expenseCategories[0];
  const topMerchant = topMerchants[0];
  const net = useMemo(() => state.summary.totals.net, [state.summary.totals.net]);
  const sentimentTone = useMemo(() => state.summary.aiHighlight.sentiment, [state.summary.aiHighlight.sentiment]);

  const customRangeError = useMemo(() => {
    if (customFromMonth && customToMonth && customFromMonth > customToMonth) {
      return "Start month must be before end month.";
    }
    return null;
  }, [customFromMonth, customToMonth]);

  const analyticsLabel = useMemo(
    () => formatMonthLabel((state.summary as any)?.period?.month ?? focusMonth ?? month),
    [focusMonth, month],
  );

  const customFromLabel = useMemo(() => formatMonthLabel(customFromMonth), [customFromMonth]);
  const customToLabel = useMemo(() => formatMonthLabel(customToMonth), [customToMonth]);

  const rangeDescription = useMemo(() => {
    if (rangeMode === "all") {
      return "Overview across your entire transaction history.";
    }
    if (rangeMode === "custom") {
      if (customRangeError) return customRangeError;
      if (customFromLabel || customToLabel) {
        if (customFromLabel && customToLabel) {
          return `Overview for ${customFromLabel} – ${customToLabel}.`;
        }
        if (customFromLabel) {
          return `Overview starting ${customFromLabel}.`;
        }
        return `Overview through ${customToLabel}.`;
      }
      return "Choose a start/end month and apply to refine the overview.";
    }
    return `Overview for ${analyticsLabel}.`;
  }, [rangeMode, customRangeError, customFromLabel, customToLabel, analyticsLabel]);

  const viewTotals = useMemo(() => {
    if (rangeMode === "month") {
      return state.summary.totals;
    }
    if (state.transactions.aggregates) {
      const { incomeTotal, expenseTotal, netTotal } = state.transactions.aggregates;
      return {
        income: incomeTotal,
        expense: expenseTotal,
        net: netTotal,
      };
    }
    const aggregated = state.transactions.transactions.reduce(
      (acc, tx) => {
        if (tx.amount > 0) acc.income += tx.amount;
        else if (tx.amount < 0) acc.expense += tx.amount;
        return acc;
      },
      { income: 0, expense: 0 },
    );
    const income = Number(aggregated.income.toFixed(2));
    const expense = Number(aggregated.expense.toFixed(2));
    return {
      income,
      expense,
      net: Number((income + expense).toFixed(2)),
    };
  }, [rangeMode, state.summary.totals, state.transactions.transactions]);

  const categoryChartData = useMemo(() => {
    if (rangeMode === "month") {
      if (expenseCategories.length === 0) return null;
      const labels = expenseCategories.map((category) => category.category);
      const data = expenseCategories.map((category) => Math.abs(category.amount));
      return {
        labels,
        datasets: [
          {
            data,
            backgroundColor: [
              "#0ea5e9",
              "#22c55e",
              "#f97316",
              "#6366f1",
              "#ec4899",
              "#14b8a6",
              "#facc15",
            ],
            borderWidth: 0,
          },
        ],
      };
    }
    const categoryTotals = state.transactions.aggregates?.categoryTotals;
    if (!categoryTotals || Object.keys(categoryTotals).length === 0) return null;
    const entries = Object.entries(categoryTotals)
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
      .slice(0, 8);
    const labels = entries.map(([name]) => name);
    const data = entries.map(([, amount]) => Math.abs(amount));
    return {
      labels,
      datasets: [
        {
          data,
          backgroundColor: [
            "#0ea5e9",
            "#22c55e",
            "#f97316",
            "#6366f1",
            "#ec4899",
            "#14b8a6",
            "#facc15",
          ],
          borderWidth: 0,
        },
      ],
    };
  }, [expenseCategories]);

  const categoryChartOptions = useMemo(() => ({
    plugins: {
      legend: {
        position: "bottom" as const,
        labels: { boxWidth: 12 },
      },
    },
    responsive: true,
    maintainAspectRatio: false,
  }), []);

  const trendChartData = useMemo(() => {
    const monthNet = state.transactions.aggregates?.monthNet;
    let labels: string[] = [];
    let data: number[] = [];
    if (monthNet && Object.keys(monthNet).length > 0) {
      labels = Object.keys(monthNet).sort();
      data = labels.map((label) => Number((monthNet[label] ?? 0).toFixed(2)));
    } else {
      if (state.transactions.transactions.length === 0) return null;
      const totalsByMonth = new Map<string, number>();
      state.transactions.transactions.forEach((tx) => {
        const date = new Date(tx.occurredAt);
        if (Number.isNaN(date.getTime())) return;
        const label = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        totalsByMonth.set(label, (totalsByMonth.get(label) ?? 0) + tx.amount);
      });
      labels = Array.from(totalsByMonth.keys()).sort();
      data = labels.map((label) => Number((totalsByMonth.get(label) ?? 0).toFixed(2)));
    }
    if (labels.length === 0) return null;
    return {
      labels: labels.map((label) => formatMonthLabel(label)),
      datasets: [
        {
          label: "Net",
          data,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 3,
        },
      ],
    };
  }, [state.transactions.transactions]);

  const trendChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label(context: any) {
            const value = context.parsed.y ?? 0;
            return formatCurrency(value);
          },
        },
      },
    },
    scales: {
      y: {
        ticks: {
          callback(value: string | number) {
            const num = typeof value === "string" ? Number(value) : value;
            return formatCurrency(num);
          },
        },
        grid: {
          color: "rgba(148, 163, 184, 0.2)",
        },
      },
      x: {
        grid: {
          display: false,
        },
      },
    },
  }), []);

  async function refreshData(overrides?: {
    focusMonth?: string;
    rangeMode?: RangeMode;
    customFrom?: string;
    customTo?: string;
    page?: number;
  }) {
    try {
      setErrorState(null);
      const activePage = overrides?.page ?? page;
      const targetSummaryMonth = overrides?.focusMonth ?? focusMonth;
      const activeRangeMode = overrides?.rangeMode ?? rangeMode;
      const fromOverride = overrides?.customFrom ?? customFromMonth;
      const toOverride = overrides?.customTo ?? customToMonth;
      const analyticsMonth = targetSummaryMonth || month;
      const now = Date.now();

      const summaryKey = cacheKey({ month: analyticsMonth });
      const cachedSummary = SUMMARY_CACHE.get(summaryKey);
      const summaryPromise = (async () => {
        if (cachedSummary && cachedSummary.expires > now) {
          return cachedSummary.data;
        }
        const fetched = await getAnalyticsSummary(analyticsMonth);
        setSummaryCache(summaryKey, fetched);
        return fetched;
      })();

      const txKey = cacheKey({
        mode: activeRangeMode,
        month: activeRangeMode === "month" ? analyticsMonth : undefined,
        from: activeRangeMode === "custom" ? fromOverride : undefined,
        to: activeRangeMode === "custom" ? toOverride : undefined,
        page: activePage,
        size: pageSize,
      });
      const cachedTx = TRANSACTIONS_CACHE.get(txKey);
      const transactionsPromise = (async () => {
        if (cachedTx && cachedTx.expires > now) {
          return cachedTx.data;
        }
        const url = new URL("/api/transactions", window.location.origin);
        url.searchParams.set("page", String(activePage));
        url.searchParams.set("pageSize", String(pageSize));
        if (activeRangeMode === "custom") {
          if (fromOverride) url.searchParams.set("from", fromOverride);
          if (toOverride) url.searchParams.set("to", toOverride);
        } else if (activeRangeMode === "month") {
          url.searchParams.set("month", analyticsMonth);
        }
        const res = await fetch(url.toString(), { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) {
          const error = new Error(
            (payload as { error?: { message?: string } })?.error?.message ?? res.statusText,
          );
          (error as any).payload = payload;
          (error as any).status = res.status;
          throw error;
        }
        const parsed = transactionsListSchema.parse(payload);
        setTransactionsCache(txKey, parsed);
        return parsed;
      })();

      const [summary, transactions] = await Promise.all([summaryPromise, transactionsPromise]);
      setState({ summary, transactions });
    } catch (e) {
      const err = e as any;
      const payload = err?.payload?.error?.backendPayload?.error || err?.payload?.error || {};
      const code = payload?.code || err?.payload?.error?.code || "UNKNOWN_ERROR";
      const traceId = payload?.traceId || err?.payload?.error?.traceId;
      const reason = payload?.details?.reason || payload?.message || err.message;
      if (code === "DB_UNAVAILABLE" || reason?.includes("Failed to obtain JDBC Connection")) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const [summary2, transactions2] = await Promise.all([
            getAnalyticsSummary(month),
            listTransactions(month),
          ]);
          setSummaryCache(cacheKey({ month }), summary2);
          setTransactionsCache(cacheKey({ mode: "month", month, page: 0, size: pageSize }), transactions2);
          setState({ summary: summary2, transactions: transactions2 });
          return;
        } catch {
          // fall through
        }
      }
      setErrorState({ code, traceId, details: reason });
    }
  }

  async function handleSync() {
    if (syncing || generatingAi || linking || sandboxLoading) return;
    setSyncing(true);
    setMessage("Syncing transactions…");
    startTransition(async () => {
      try {
        const payload: Parameters<typeof triggerTransactionSync>[0] = {};
        if (startMonth) payload.startMonth = startMonth;
        await triggerTransactionSync(payload);
        clearDataCaches();
        await refreshData();
        setMessage("Sync triggered successfully.");
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "Sync failed.");
      } finally {
        setSyncing(false);
      }
    });
  }

  async function handleReset() {
    if (syncing || generatingAi || linking || sandboxLoading) return;
    const confirmMsg = unlinkPlaid
      ? "This will delete all transactions and unlink your Plaid account. Continue?"
      : "This will delete all transactions. Continue?";
    if (!window.confirm(confirmMsg)) return;
    setMessage("Resetting transactions…");
    startTransition(async () => {
      try {
        await resetTransactions({ unlinkPlaid });
        clearDataCaches();
        await refreshData();
        setMessage("Transactions reset requested.");
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "Reset failed.");
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
      setMessage("Opening Plaid Link…");
      let plaid;
      try {
        plaid = await loadPlaidLink();
      } catch (error) {
        console.warn("Plaid load failed; retrying", error);
        plaid = await loadPlaidLink(45000);
      }
      const handler = plaid.create({
        token: token.linkToken,
        onSuccess: async (publicToken: string) => {
          try {
            setMessage("Link successful. Finalising…");
            await exchangePlaidPublicToken(publicToken);
            setMessage("Account linked. Syncing transactions…");
            await triggerTransactionSync();
            clearDataCaches();
            await refreshData();
            setMessage("Plaid account linked and sync triggered.");
          } catch (error) {
            console.error(error);
            setMessage((error as Error).message ?? "Failed to finalise Plaid link.");
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
            setMessage("Plaid Link closed.");
          }
          handler.destroy?.();
          setLinking(false);
        },
        onEvent: (eventName, metadata) => {
          if (eventName === "ERROR") {
            console.error("[PlaidLink] error", metadata);
            const code = (metadata as any)?.error_code || (metadata as any)?.status || "UNKNOWN";
            const msg = (metadata as any)?.error_message || (metadata as any)?.message || "Plaid initialisation failed";
            setMessage(`Plaid error (${code}): ${msg}`);
          }
        },
      });
      handler.open();
    } catch (error) {
      console.error(error);
      setMessage((error as Error).message ?? "Unable to start Plaid Link.");
      setLinking(false);
    }
  }

  async function handleGenerateAi() {
    if (generatingAi || syncing || linking || sandboxLoading) return;
    setGeneratingAi(true);
    setMessage("Generating AI summary…");
    const analyticsMonth = focusMonth || month;
    startTransition(async () => {
      try {
        const summary = await getAnalyticsSummary(analyticsMonth, { generateAi: true });
        setState((prev) => ({ ...prev, summary }));
        setAiReady(true);
        setMessage("AI summary generated.");
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "AI summary failed.");
      } finally {
        setGeneratingAi(false);
      }
    });
  }

  async function handleSandboxDemo() {
    if (sandboxLoading || syncing || generatingAi || linking) return;
    setSandboxLoading(true);
    setMessage("Loading demo data…");
    startTransition(async () => {
      try {
        await triggerTransactionSync({ forceFullSync: true, demoSeed: true });
        clearDataCaches();
        await refreshData();
        setMessage("Demo data loaded.");
        setAiReady(true);
      } catch (error) {
        console.error(error);
        setMessage((error as Error).message ?? "Demo load failed.");
      } finally {
        setSandboxLoading(false);
      }
    });
  }

  function handleRangeModeChange(next: RangeMode) {
    if (next === rangeMode) return;
    setRangeMode(next);
    setPage(0);
    setMessage(null);
    if (next === "custom") {
      return;
    }
    startTransition(() => refreshData({ rangeMode: next, page: 0 }));
  }

  function handleCustomApply() {
    if (!customFromMonth && !customToMonth) {
      setMessage("Select at least a start or end month to apply.");
      return;
    }
    if (customRangeError) {
      setMessage(customRangeError);
      return;
    }
    setRangeMode("custom");
    setPage(0);
    setMessage("Custom range applied.");
    startTransition(() => refreshData({ rangeMode: "custom", customFrom: customFromMonth, customTo: customToMonth, page: 0 }));
  }

  function handleClearRange() {
    setCustomFromMonth("");
    setCustomToMonth("");
    setRangeMode("month");
    setPage(0);
    setMessage(null);
    startTransition(() => refreshData({ rangeMode: "month", customFrom: "", customTo: "", page: 0 }));
  }

  return (
    <div className="flex flex-col gap-8 bg-slate-100 p-8 text-slate-900">
      {errorState ? (
        <div className="rounded-2xl border border-amber-200/80 bg-amber-50/70 p-5 shadow-sm">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold text-amber-900">{friendlyTitle(errorState.code)}</div>
            <div className="text-xs text-amber-800">{friendlyBody(errorState)}</div>
            {errorState.traceId ? (
              <div className="text-xs text-amber-600">Trace ID: {errorState.traceId}</div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => { startTransition(() => refreshData()); }}
                disabled={isPending}
                className="rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-60"
              >
                Retry
              </button>
              <button
                onClick={() => setErrorState(null)}
                className="rounded-full border border-amber-300 px-4 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          onClick={() => setActionsOpen(true)}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100"
        >
          Manage connections & sync
        </button>
      </div>

      <section className="grid gap-6">
        <div className="rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">View period</span>
                <p className="max-w-xl text-sm text-slate-500">{rangeDescription}</p>
              </div>
              <div className="flex flex-col items-start gap-3 lg:items-end">
                <div className="flex flex-wrap gap-2 rounded-full bg-slate-100/80 p-1">
                  {RANGE_SEGMENTS.map((segment) => {
                    const active = segment.value === rangeMode;
                    return (
                      <button
                        key={segment.value}
                        onClick={() => handleRangeModeChange(segment.value)}
                        className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                          active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}
                        type="button"
                        aria-pressed={active}
                      >
                        {segment.label}
                      </button>
                    );
                  })}
                </div>
                {rangeMode === "month" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="focusMonth"
                      type="month"
                      value={focusMonth}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFocusMonth(value);
                        setPage(0);
                        setMessage(null);
                        startTransition(() => refreshData({ focusMonth: value, page: 0 }));
                      }}
                      className="rounded-full border border-slate-300 bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
                    />
                    {focusMonth !== month ? (
                      <button
                        onClick={() => {
                          setFocusMonth(month);
                          setPage(0);
                          setMessage(null);
                          startTransition(() => refreshData({ focusMonth: month, page: 0 }));
                        }}
                        className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
                        type="button"
                      >
                        Reset
                      </button>
                    ) : null}
                    <span className="text-[11px] text-slate-500">AI highlight follows this month.</span>
                  </div>
                ) : rangeMode === "all" ? (
                  <span className="text-[11px] text-slate-500">Includes every synced month.</span>
                ) : null}
              </div>
            </div>

            {rangeMode === "custom" ? (
              <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4">
                <div className="flex flex-col gap-1">
                  <label htmlFor="customFrom" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">From</label>
                  <input
                    id="customFrom"
                    type="month"
                    value={customFromMonth}
                    onChange={(e) => setCustomFromMonth(e.target.value)}
                    className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="customTo" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">To</label>
                  <input
                    id="customTo"
                    type="month"
                    value={customToMonth}
                    onChange={(e) => setCustomToMonth(e.target.value)}
                    className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCustomApply}
                    className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
                    type="button"
                    disabled={!!customRangeError}
                  >
                    Apply
                  </button>
                  <button
                    onClick={handleClearRange}
                    className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
                    type="button"
                  >
                    Clear
                  </button>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-3">
              <SummaryCard title="Income" value={formatCurrency(viewTotals.income)} tone="positive" />
              <SummaryCard title="Expenses" value={formatCurrency(viewTotals.expense)} tone="negative" />
              <SummaryCard title="Net" value={formatCurrency(viewTotals.net)} tone="neutral" />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="min-h-[280px] rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
                <h2 className="text-lg font-semibold tracking-tight text-slate-900">Spending mix</h2>
                <p className="text-sm text-slate-500">Category distribution for the current view.</p>
                <div className="mt-4 h-56">
                  {categoryChartData ? (
                    <Doughnut data={categoryChartData} options={categoryChartOptions} />
                  ) : (
                    <p className="text-sm text-slate-500">Not enough category data yet.</p>
                  )}
                </div>
              </div>
              <div className="min-h-[280px] rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
                <h2 className="text-lg font-semibold tracking-tight text-slate-900">Net trend</h2>
                <p className="text-sm text-slate-500">Monthly net movement based on the selected period.</p>
                <div className="mt-4 h-56">
                  {trendChartData ? (
                    <Line data={trendChartData} options={trendChartOptions} />
                  ) : (
                    <p className="text-sm text-slate-500">Add more transactions or expand the range to see a trend.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {message ? <p className="text-xs text-slate-500">{message}</p> : null}
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Spend by Category</h2>
          <p className="mb-4 text-sm text-slate-500">Top categories for {analyticsLabel}.</p>
          <ul className="space-y-3">
            {expenseCategories.map((category) => (
              <li key={category.category} className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{category.category}</span>
                <span className="text-slate-500">
                  {formatCurrency(category.amount)} · {category.percentage.toFixed(1)}%
                </span>
              </li>
            ))}
            {expenseCategories.length === 0 ? <p className="text-sm text-slate-500">No expense activity.</p> : null}
          </ul>
        </div>
        <div className="rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Top Merchants</h2>
          <p className="mb-4 text-sm text-slate-500">Highest activity merchants.</p>
          <ul className="space-y-3">
            {topMerchants.map((merchant) => (
              <li key={merchant.merchant} className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{merchant.merchant}</span>
                <span className="text-slate-500">
                  {formatCurrency(merchant.amount)} · {merchant.transactionCount} tx
                </span>
              </li>
            ))}
            {topMerchants.length === 0 ? <p className="text-sm text-slate-500">No merchant activity.</p> : null}
          </ul>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">AI Monthly Highlight</h2>
        {!aiReady ? (
          <p className="mt-2 text-sm text-slate-500">Click "Generate AI Summary" to create an AI highlight for {analyticsLabel}.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="text-sm text-slate-600">{state.summary.aiHighlight.title}</p>
              <SentimentBadge sentiment={sentimentTone} />
            </div>
            <p className="mt-3 text-sm text-slate-700">{state.summary.aiHighlight.summary}</p>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-slate-600">
              <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Net this month: <span className="font-medium text-slate-900">{formatCurrency(net)}</span></li>
              <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Anomaly alerts: <span className="font-medium text-slate-900">{anomalies.length}</span></li>
              {topCategory ? (
                <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Top category: <span className="font-medium text-slate-900">{topCategory.category}</span> · {formatCurrency(topCategory.amount)}</li>
              ) : null}
              {topMerchant ? (
                <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">Top merchant: <span className="font-medium text-slate-900">{topMerchant.merchant}</span> · {formatCurrency(topMerchant.amount)}</li>
              ) : null}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
              {state.summary.aiHighlight.recommendations.map((recommendation) => (
                <span
                  key={recommendation}
                  className="rounded-full border border-slate-200 bg-white px-4 py-1 font-medium text-slate-600"
                >
                  {recommendation}
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Anomaly Watch</h2>
          <span className="text-xs text-slate-500">{anomalies.length} alert{anomalies.length === 1 ? "" : "s"}</span>
        </div>
        <div className="flow-root overflow-hidden rounded-2xl border border-slate-100">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50">
              <tr className="border-b border-slate-200/90">
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Delta</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Impact</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Occurred</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {anomalies.map((anomaly) => (
                <tr key={anomaly.transactionId} className="hover:bg-slate-50/60">
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
                    No anomalies detected for this selection.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Recent Transactions</h2>
          <span className="text-xs text-slate-500">Page {page + 1}</span>
        </div>
        <div className="flow-root overflow-hidden rounded-2xl border border-slate-100">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50">
              <tr className="border-b border-slate-200/90">
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Category</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {state.transactions.transactions.map((transaction) => (
                <tr key={transaction.id} className="hover:bg-slate-50/60">
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
        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={() => {
              if (page > 0) {
                const nextPage = page - 1;
                setPage(nextPage);
                startTransition(() => refreshData({ page: nextPage }));
              }
            }}
            disabled={page === 0}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
          >
            Previous
          </button>
          <div className="text-xs text-slate-500">{state.transactions.transactions.length} records</div>
          <button
            onClick={() => {
              const nextPage = page + 1;
              setPage(nextPage);
              startTransition(() => refreshData({ page: nextPage }));
            }}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Next
          </button>
        </div>
      </section>

      {actionsOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8"
          onClick={() => setActionsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-3xl border border-slate-200/70 bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-slate-900">Accounts & Sync</h2>
                <p className="text-xs text-slate-500">Link accounts, trigger syncs, or load demo data.</p>
              </div>
              <button
                onClick={() => setActionsOpen(false)}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
                <label htmlFor="modalSyncStart" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Sync from
                </label>
                <input
                  id="modalSyncStart"
                  type="month"
                  value={startMonth}
                  onChange={(e) => setStartMonth(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
                />
                <p className="mt-1 text-[11px] text-slate-500">Optional month to backfill when syncing.</p>
              </div>

              <button
                onClick={handleLink}
                className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
                disabled={isPending || linking || syncing || generatingAi || sandboxLoading}
              >
                {linking ? "Opening Plaid…" : "Link Accounts with Plaid"}
              </button>
              <button
                onClick={handleSync}
                className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
                disabled={isPending || linking || generatingAi || syncing || sandboxLoading}
              >
                {syncing ? "Syncing…" : "Sync Transactions"}
              </button>
              <button
                onClick={handleGenerateAi}
                className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
                disabled={isPending || linking || syncing || generatingAi || sandboxLoading}
              >
                {generatingAi ? "Generating…" : "Generate AI Summary"}
              </button>
              <button
                onClick={handleSandboxDemo}
                className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
                disabled={isPending || sandboxLoading || syncing || generatingAi || linking}
              >
                {sandboxLoading ? "Loading demo…" : "Try Demo Data"}
              </button>

              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
                <label className="flex items-center justify-between text-xs font-medium text-slate-600">
                  <span>Unlink Plaid on reset</span>
                  <input type="checkbox" checked={unlinkPlaid} onChange={(e) => setUnlinkPlaid(e.target.checked)} />
                </label>
                <button
                  onClick={handleReset}
                  className="mt-3 w-full rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-60"
                  disabled={isPending || linking || generatingAi || syncing || sandboxLoading}
                >
                  Reset Data
                </button>
              </div>

              {message ? <p className="text-xs text-slate-500">{message}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  value: string;
  tone: "positive" | "negative" | "neutral";
}

function SummaryCard({ title, value, tone }: SummaryCardProps) {
  const toneStyles: Record<SummaryCardProps["tone"], { value: string; glow: string }> = {
    positive: { value: "text-emerald-600", glow: "from-emerald-400/20" },
    negative: { value: "text-rose-500", glow: "from-rose-400/20" },
    neutral: { value: "text-slate-600", glow: "from-slate-400/20" },
  };
  return (
    <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 border-t-white/80 bg-gradient-to-b from-white to-slate-50 p-6 shadow-[0_4px_12px_rgba(0,0,0,0.04),_0_1px_4px_rgba(0,0,0,0.05)]">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <p className={`mt-3 text-3xl font-semibold tracking-tight ${toneStyles[tone].value}`}>{value}</p>
      <div
        className={`pointer-events-none absolute -bottom-10 left-0 h-12 w-full rounded-full bg-gradient-to-r ${toneStyles[tone].glow} via-transparent to-transparent opacity-80`}
      />
    </div>
  );
}

function SentimentBadge({ sentiment }: { sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" }) {
  const styles: Record<typeof sentiment, string> = {
    POSITIVE: "border-emerald-200 bg-emerald-50 text-emerald-600",
    NEUTRAL: "border-slate-200 bg-slate-50 text-slate-600",
    NEGATIVE: "border-rose-200 bg-rose-50 text-rose-600",
  } as const;
  return (
    <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${styles[sentiment]}`}>
      {sentiment}
    </span>
  );
}

function friendlyTitle(code: string): string {
  switch (code) {
    case "DB_SCHEMA_MISSING":
      return "Database schema missing";
    case "DB_NOT_FOUND":
      return "Database not initialised";
    case "DB_UNAVAILABLE":
      return "Database warming up";
    case "ANALYTICS_FETCH_FAILED":
      return "Analytics temporarily unavailable";
    case "INTERNAL_ERROR":
      return "Service error";
    default:
      return "Unexpected issue";
  }
}

function friendlyBody(err: { code: string; traceId?: string; details?: string }): string {
  switch (err.code) {
    case "DB_SCHEMA_MISSING":
      return "Required tables are missing. Run migrations before continuing.";
    case "DB_NOT_FOUND":
      return "The configured database does not exist yet. Create it and retry.";
    case "DB_UNAVAILABLE":
      return "The database connection was not ready. Retrying usually fixes this shortly.";
    case "ANALYTICS_FETCH_FAILED":
      return "We could not fetch your analytics data. Retry now or refresh later.";
    case "INTERNAL_ERROR":
      return "An internal error occurred. If this persists, contact support with the trace ID.";
    default:
      return err.details || "An unknown error occurred.";
  }
}

function formatMonthLabel(value?: string | null): string {
  if (!value) return "";
  const parts = value.split("-");
  if (parts.length < 2) return value;
  const [year, month] = parts.map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return value;
  const date = new Date(year, month - 1, 1);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
}
