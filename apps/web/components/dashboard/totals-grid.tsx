import { formatCurrency } from "@/src/lib/date";
import type { TotalsSummary } from "./types";

interface TotalsGridProps {
  totals: TotalsSummary;
}

export function TotalsGrid({ totals }: TotalsGridProps) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SummaryCard title="Income" value={formatCurrency(totals.income)} tone="positive" />
      <SummaryCard title="Expenses" value={formatCurrency(totals.expense)} tone="negative" />
      <SummaryCard title="Net" value={formatCurrency(totals.net)} tone="neutral" />
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
    positive: { value: "text-emerald-600", glow: "from-emerald-200/50" },
    negative: { value: "text-rose-500", glow: "from-rose-200/50" },
    neutral: { value: "text-slate-700", glow: "from-slate-200/50" },
  };
  return (
    <div className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <p className={`mt-3 text-3xl font-semibold tracking-tight ${toneStyles[tone].value}`}>{value}</p>
      <div className={`mt-4 h-1 rounded-full bg-gradient-to-r ${toneStyles[tone].glow} via-transparent to-transparent`} />
    </div>
  );
}
