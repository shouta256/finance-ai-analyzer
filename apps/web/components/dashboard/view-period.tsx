import { Button } from "@/components/ui/button";
import type { RangeMode } from "./types";

interface DashboardViewPeriodProps {
  rangeMode: RangeMode;
  focusMonth: string;
  defaultMonth: string;
  rangeDescription: string;
  onOpenPeriod: () => void;
  onOpenActions: () => void;
}

export function DashboardViewPeriod(props: DashboardViewPeriodProps) {
  const { rangeMode, focusMonth, defaultMonth, rangeDescription, onOpenPeriod, onOpenActions } = props;

  return (
    <div className="rounded-3xl border border-slate-200/70 bg-white/80 px-5 py-3 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold uppercase tracking-[0.2em] text-slate-500">View</span>
          <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700">
            {rangeMode === "month" ? (focusMonth || defaultMonth) : rangeMode === "all" ? "All history" : "Custom range"}
          </span>
          <span className="hidden sm:inline">· {rangeDescription}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenPeriod}
            className="rounded-full border-slate-300 bg-white text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-100"
            type="button"
          >
            Change period
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenActions}
            className="rounded-full border-slate-300 bg-white text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-100"
            type="button"
          >
            Manage connections & sync
          </Button>
        </div>
      </div>
    </div>
  );
}
