import type { RangeMode } from "./types";

interface DashboardViewPeriodProps {
  focusMonth: string;
  defaultMonth: string;
  rangeMode: RangeMode;
  onRangeModeChange: (mode: RangeMode) => void;
  onFocusMonthChange: (month: string) => void;
  onResetFocusMonth: () => void;
  customFromMonth: string;
  customToMonth: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onApplyCustomRange: () => void;
  onClearCustomRange: () => void;
  customRangeError: string | null;
  rangeDescription: string;
  onOpenActions: () => void;
}

const RANGE_SEGMENTS: Array<{ value: RangeMode; label: string }> = [
  { value: "month", label: "Single month" },
  { value: "all", label: "All history" },
  { value: "custom", label: "Custom range" },
];

export function DashboardViewPeriod(props: DashboardViewPeriodProps) {
  const {
    focusMonth,
    defaultMonth,
    rangeMode,
    onRangeModeChange,
    onFocusMonthChange,
    onResetFocusMonth,
    customFromMonth,
    customToMonth,
    onCustomFromChange,
    onCustomToChange,
    onApplyCustomRange,
    onClearCustomRange,
    customRangeError,
    rangeDescription,
    onOpenActions,
  } = props;

  return (
    <div className="rounded-3xl border border-slate-200/70 bg-white/80 px-5 py-4 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">View period</span>
          <p className="max-w-xl text-xs text-slate-500">{rangeDescription}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <div className="flex flex-wrap gap-2 rounded-full bg-slate-100/80 p-1">
            {RANGE_SEGMENTS.map((segment) => {
              const active = segment.value === rangeMode;
              return (
                <button
                  key={segment.value}
                  onClick={() => onRangeModeChange(segment.value)}
                  className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
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
          {rangeMode === "month" && (
            <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
              <input
                id="focusMonth"
                type="month"
                value={focusMonth}
                onChange={(event) => onFocusMonthChange(event.target.value)}
                className="w-28 border-none bg-transparent text-sm font-medium text-slate-900 focus:outline-none focus:ring-0"
              />
              {focusMonth !== defaultMonth ? (
                <button
                  onClick={onResetFocusMonth}
                  className="text-[11px] font-semibold text-slate-500 transition hover:text-slate-700"
                  type="button"
                >
                  Reset
                </button>
              ) : null}
            </div>
          )}
          {rangeMode === "all" ? <span className="text-[11px] text-slate-500">Full history</span> : null}
          <button
            onClick={onOpenActions}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100"
            type="button"
          >
            Manage connections & sync
          </button>
        </div>
      </div>
      {rangeMode === "custom" && (
        <div className="mt-4 flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="customFrom" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              From
            </label>
            <input
              id="customFrom"
              type="month"
              value={customFromMonth}
              onChange={(event) => onCustomFromChange(event.target.value)}
              className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="customTo" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              To
            </label>
            <input
              id="customTo"
              type="month"
              value={customToMonth}
              onChange={(event) => onCustomToChange(event.target.value)}
              className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onApplyCustomRange}
              className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
              type="button"
              disabled={!!customRangeError}
            >
              Apply
            </button>
            <button
              onClick={onClearCustomRange}
              className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              type="button"
            >
              Clear
            </button>
          </div>
          {customRangeError ? <p className="text-xs text-rose-500">{customRangeError}</p> : null}
        </div>
      )}
    </div>
  );
}
