import { formatCurrency } from "@/src/lib/date";
import type { AnalyticsSummary } from "@/src/lib/dashboard-data";

interface SafeToSpendCardProps {
  data: AnalyticsSummary["safeToSpend"];
}

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function SafeToSpendCard({ data }: SafeToSpendCardProps) {
  const cycleStart = new Date(`${data.cycleStart}T00:00:00Z`);
  const cycleEnd = new Date(`${data.cycleEnd}T00:00:00Z`);
  const cycleLabel = `${dateFormatter.format(cycleStart)} – ${dateFormatter.format(cycleEnd)}`;
  const variableProgress = data.variableBudget > 0 ? Math.min(1, data.variableSpent / data.variableBudget) : 0;
  const progressPercent = Math.round(variableProgress * 100);
  const safeAllowance = Math.max(0, data.dailyAdjusted + data.rollToday);

  return (
    <section
      className={`rounded-3xl border p-6 shadow-sm ${
        data.danger ? "border-rose-200/80 bg-rose-50" : "border-slate-200/70 bg-white/80"
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Safe to spend today</h2>
          <p className="text-sm text-slate-500">{cycleLabel} cycle &middot; {data.daysRemaining} day{data.daysRemaining === 1 ? "" : "s"} left</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Allowance</p>
          <p className="text-3xl font-semibold text-slate-900">{formatCurrency(data.safeToSpendToday)}</p>
          <p className="text-xs text-slate-500">Hard cap {formatCurrency(data.hardCap)}</p>
        </div>
      </div>
      {data.danger ? (
        <div className="mt-4 rounded-2xl border border-rose-300 bg-rose-100/80 px-4 py-3 text-sm text-rose-700">
          Hard cap is exhausted. Prioritise trimming, deferring, or swapping upcoming spends.
        </div>
      ) : null}
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Metric label="Daily base" value={formatCurrency(data.dailyBase)} />
        <Metric label="Paced allowance" value={formatCurrency(data.dailyAdjusted)} hint={`${(data.adjustmentFactor * 100).toFixed(0)}% pacing`} />
        <Metric label="Roll available" value={formatCurrency(data.rollToday)} hint={safeAllowance > 0 ? `${Math.round((data.rollToday / safeAllowance) * 100)}% of today` : undefined} />
      </div>
      <div className="mt-6">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Variable spend</span>
          <span>
            {formatCurrency(data.variableSpent)} / {formatCurrency(data.variableBudget)}
          </span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-100">
          <div
            className={`h-2 rounded-full ${data.danger ? "bg-rose-500" : variableProgress > 1 ? "bg-rose-400" : "bg-indigo-500"}`}
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {progressPercent}% of variable budget used · {data.daysRemaining} day{data.daysRemaining === 1 ? "" : "s"} remaining
        </p>
      </div>
      {data.notes.length > 0 ? (
        <ul className="mt-5 space-y-2 text-sm text-slate-600">
          {data.notes.map((note) => (
            <li key={note} className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 rounded-full bg-indigo-400" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface MetricProps {
  label: string;
  value: string;
  hint?: string;
}

function Metric({ label, value, hint }: MetricProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.25em] text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
