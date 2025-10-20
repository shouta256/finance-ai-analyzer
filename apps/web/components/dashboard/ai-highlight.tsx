import { formatCurrency, formatDateTime } from "@/src/lib/date";
import type { AnalyticsSummary } from "@/src/lib/dashboard-data";

interface AiHighlightCardProps {
  aiReady: boolean;
  analyticsLabel: string;
  summary: AnalyticsSummary;
  netValue: string;
  anomalyCount: number;
  topCategory?: { category: string; amount: number };
  topMerchant?: { merchant: string; amount: number };
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  onGenerate?: () => void;
  generateDisabled?: boolean;
}

export function AiHighlightCard(props: AiHighlightCardProps) {
  const {
    aiReady,
    analyticsLabel,
    summary,
    netValue,
    anomalyCount,
    topCategory,
    topMerchant,
    sentiment,
    onGenerate,
    generateDisabled,
  } = props;
  return (
    <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">AI Monthly Highlight</h2>
      {!aiReady ? (
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-500">
            Click the button to generate an AI highlight for {analyticsLabel}.
          </p>
          {onGenerate ? (
            <button
              type="button"
              onClick={onGenerate}
              disabled={generateDisabled}
              className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Generate AI Summary
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-600">{summary.aiHighlight.title}</p>
            <SentimentBadge sentiment={sentiment} />
          </div>
          <p className="mt-3 text-sm text-slate-700">{summary.aiHighlight.summary}</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 text-xs text-slate-600">
            <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              Net this period: <span className="font-medium text-slate-900">{netValue}</span>
            </li>
            <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              Anomaly alerts: <span className="font-medium text-slate-900">{anomalyCount}</span>
            </li>
            {topCategory ? (
              <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                Top category: <span className="font-medium text-slate-900">{topCategory.category}</span> ·{" "}
                {formatCurrency(topCategory.amount)}
              </li>
            ) : null}
            {topMerchant ? (
              <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                Top merchant: <span className="font-medium text-slate-900">{topMerchant.merchant}</span> ·{" "}
                {formatCurrency(topMerchant.amount)}
              </li>
            ) : null}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
            {summary.aiHighlight.recommendations.map((recommendation) => (
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
  );
}

interface AnomaliesTableProps {
  anomalies: AnalyticsSummary["anomalies"];
}

export function AnomaliesTable({ anomalies }: AnomaliesTableProps) {
  return (
    <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Anomaly Watch</h2>
        <span className="text-xs text-slate-500">{anomalies.length} alert{anomalies.length === 1 ? "" : "s"}</span>
      </div>
      <div className="flow-root overflow-hidden rounded-2xl border border-slate-100">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50">
            <tr>
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
                <td className="px-4 py-2 text-slate-600">{anomaly.budgetImpactPercent.toFixed(2)}%</td>
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
