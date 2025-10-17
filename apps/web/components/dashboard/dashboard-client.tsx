/* eslint-disable max-lines */
'use client';

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChartData, ChartOptions } from "chart.js";
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
import { DashboardViewPeriod } from "./view-period";
import { TotalsGrid } from "./totals-grid";
import { ChartsSection } from "./charts-section";
import { AiHighlightCard, AnomaliesTable } from "./ai-highlight";
import { TransactionsTable } from "./transactions-table";
import { DashboardActionsModal } from "./actions-modal";
import { InlineError } from "./inline-error";
import type { RangeMode, TotalsSummary } from "./types";

interface DashboardClientProps {
  month: string;
  initialSummary: AnalyticsSummary;
  initialTransactions: TransactionsList;
}

interface FetchState {
  summary: AnalyticsSummary;
  transactions: TransactionsList;
}

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

const setSummaryCache = (key: string, data: AnalyticsSummary) => {
  SUMMARY_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
};

const setTransactionsCache = (key: string, data: TransactionsList) => {
  TRANSACTIONS_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
};

export function DashboardClient({ month, initialSummary, initialTransactions }: DashboardClientProps) {
  const router = useRouter();
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
    const handleOpenModal = () => setActionsOpen(true);
    window.addEventListener("open-actions-modal", handleOpenModal);
    return () => {
      window.removeEventListener("open-actions-modal", handleOpenModal);
    };
  }, []);

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
    () => formatMonthLabel(state.summary.period?.month ?? focusMonth ?? month),
    [state.summary.period?.month, focusMonth, month],
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

  const viewTotals = useMemo<TotalsSummary>(() => {
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
  }, [rangeMode, state.summary.totals, state.transactions]);

  const categoryChartData = useMemo<ChartData<"doughnut"> | null>(() => {
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
  }, [rangeMode, expenseCategories, state.transactions.aggregates]);

  const categoryChartOptions = useMemo<ChartOptions<"doughnut">>(() => ({
    plugins: {
      legend: {
        position: "bottom",
        labels: { boxWidth: 12 },
      },
    },
    responsive: true,
    maintainAspectRatio: false,
  }), []);

  const trendChartData = useMemo<ChartData<"line"> | null>(() => {
    if (rangeMode === "month") {
      if (state.transactions.transactions.length === 0) return null;
      const totalsByDay = new Map<string, number>();
      state.transactions.transactions.forEach((tx) => {
        const date = new Date(tx.occurredAt);
        if (Number.isNaN(date.getTime())) return;
        const label = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
          date.getUTCDate(),
        ).padStart(2, "0")}`;
        totalsByDay.set(label, (totalsByDay.get(label) ?? 0) + tx.amount);
      });
      const labels = Array.from(totalsByDay.keys()).sort();
      const data = labels.map((label) => Number((totalsByDay.get(label) ?? 0).toFixed(2)));
      if (labels.length === 0) return null;
      return {
        labels: labels.map((label) => {
          const date = new Date(label);
          return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
        }),
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
    }

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
  }, [state.transactions, rangeMode]);

  const trendChartOptions = useMemo<ChartOptions<"line">>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label(context) {
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
      const code = err?.payload?.error?.code || "UNKNOWN_ERROR";
      if (err.status === 401 || code === "UNAUTHENTICATED") {
        router.push("/login");
        return;
      }

      const payload = err?.payload?.error?.backendPayload?.error || err?.payload?.error || {};
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

  const handleCustomApply = () => {
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
  };

  const handleClearRange = () => {
    setCustomFromMonth("");
    setCustomToMonth("");
    setRangeMode("month");
    setPage(0);
    setMessage(null);
    startTransition(() => refreshData({ rangeMode: "month", customFrom: "", customTo: "", page: 0 }));
  };

  const handlePageChange = (nextPage: number) => {
    const safePage = Math.max(nextPage, 0);
    setPage(safePage);
    startTransition(() => refreshData({ page: safePage }));
  };

  return (
    <div className="flex flex-col gap-8 text-slate-900">
      {errorState ? (
        <InlineError
          title={friendlyTitle(errorState.code)}
          body={friendlyBody(errorState)}
          traceId={errorState.traceId}
          onRetry={() => startTransition(() => refreshData())}
          onDismiss={() => setErrorState(null)}
          retryDisabled={isPending}
        />
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)]">
        <DashboardViewPeriod
          focusMonth={focusMonth}
          defaultMonth={month}
          rangeMode={rangeMode}
          onRangeModeChange={(mode) => {
            if (mode === "custom") {
              setRangeMode(mode);
              return;
            }
            setRangeMode(mode);
            setPage(0);
            startTransition(() => refreshData({ rangeMode: mode, page: 0 }));
          }}
          onFocusMonthChange={(value) => {
            setFocusMonth(value);
            setPage(0);
            setMessage(null);
            startTransition(() => refreshData({ focusMonth: value, page: 0 }));
          }}
          onResetFocusMonth={() => {
            setFocusMonth(month);
            setPage(0);
            setMessage(null);
            startTransition(() => refreshData({ focusMonth: month, page: 0 }));
          }}
          customFromMonth={customFromMonth}
          customToMonth={customToMonth}
          onCustomFromChange={setCustomFromMonth}
          onCustomToChange={setCustomToMonth}
          onApplyCustomRange={handleCustomApply}
          onClearCustomRange={handleClearRange}
          customRangeError={customRangeError}
          rangeDescription={rangeDescription}
        />

        <TotalsGrid totals={viewTotals} />
        <ChartsSection
          categoryData={categoryChartData}
          categoryOptions={categoryChartOptions}
          trendData={trendChartData}
          trendOptions={trendChartOptions}
        />
      </section>

      <AiHighlightCard
        aiReady={aiReady}
        analyticsLabel={analyticsLabel}
        summary={state.summary}
        netValue={formatCurrency(net)}
        anomalyCount={anomalies.length}
        topCategory={topCategory}
        topMerchant={topMerchant}
        sentiment={sentimentTone}
      />

      <AnomaliesTable anomalies={anomalies} />

      <TransactionsTable
        transactions={state.transactions.transactions}
        page={page}
        pageSize={pageSize}
        onPageChange={handlePageChange}
      />

      <DashboardActionsModal
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        startMonth={startMonth}
        onStartMonthChange={setStartMonth}
        onLinkPlaid={handleLink}
        onSync={handleSync}
        onGenerateAi={handleGenerateAi}
        onLoadDemo={handleSandboxDemo}
        onReset={handleReset}
        canLink={!isPending && !linking}
        canSync={!isPending && !syncing}
        canGenerateAi={!isPending && !generatingAi}
        canLoadDemo={!isPending && !sandboxLoading}
        canReset={!isPending && !sandboxLoading && !syncing}
        unlinkPlaid={unlinkPlaid}
        onToggleUnlink={setUnlinkPlaid}
        message={message}
      />
    </div>
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
