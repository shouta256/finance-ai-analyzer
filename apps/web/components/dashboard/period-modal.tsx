import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MonthPicker } from "@/components/ui/month-picker";
import { cn } from "@/lib/utils";

interface PeriodModalProps {
  open: boolean;
  onClose: () => void;
  // Controls
  rangeMode: import("./types").RangeMode;
  onRangeModeChange: (mode: import("./types").RangeMode) => void;
  focusMonth: string;
  defaultMonth: string;
  onFocusMonthChange: (value: string) => void;
  onResetFocusMonth: () => void;
  customFromMonth: string;
  customToMonth: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onApplyCustomRange: () => void;
  onClearCustomRange: () => void;
  customRangeError: string | null;
}

const RANGE_SEGMENTS: Array<{ value: import("./types").RangeMode; label: string }> = [
  { value: "month", label: "Single month" },
  { value: "all", label: "All history" },
  { value: "custom", label: "Custom range" },
];

export function PeriodModal(props: PeriodModalProps) {
  const {
    open,
    onClose,
    rangeMode,
    onRangeModeChange,
    focusMonth,
    defaultMonth,
    onFocusMonthChange,
    onResetFocusMonth,
    customFromMonth,
    customToMonth,
    onCustomFromChange,
    onCustomToChange,
    onApplyCustomRange,
    onClearCustomRange,
    customRangeError,
  } = props;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="w-full max-w-lg rounded-3xl border border-slate-200/70 bg-white">
        <DialogHeader className="items-start">
          <DialogTitle className="text-lg font-semibold tracking-tight text-slate-900">Change period</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Adjust the time range shown across your dashboard insights.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2 rounded-full bg-slate-100/80 p-1">
          {RANGE_SEGMENTS.map((segment) => {
            const active = segment.value === rangeMode;
            return (
              <Button
                key={segment.value}
                variant="ghost"
                size="sm"
                className={cn(
                  "rounded-full px-4 text-sm font-medium",
                  active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
                type="button"
                onClick={() => onRangeModeChange(segment.value)}
                aria-pressed={active}
              >
                {segment.label}
              </Button>
            );
          })}
        </div>

        {rangeMode === "month" ? (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 shadow-sm">
            <MonthPicker
              id="focusMonthModal"
              value={focusMonth}
              onChange={onFocusMonthChange}
              className="w-full border-none bg-transparent text-sm font-medium text-slate-900 focus-visible:ring-0"
            />
            {focusMonth !== defaultMonth ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onResetFocusMonth}
                className="h-7 rounded-full px-2 text-[11px] font-semibold text-slate-500 hover:text-slate-700"
              >
                Reset
              </Button>
            ) : null}
          </div>
        ) : null}

        {rangeMode === "custom" ? (
          <div className="mt-4 flex flex-wrap items-end gap-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="customFromModal" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                From
              </Label>
              <MonthPicker
                id="customFromModal"
                value={customFromMonth}
                onChange={onCustomFromChange}
                className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="customToModal" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                To
              </Label>
              <MonthPicker
                id="customToModal"
                value={customToMonth}
                onChange={onCustomToChange}
                className="rounded-xl border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={onApplyCustomRange}
                disabled={!!customRangeError}
                className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                type="button"
              >
                Apply
              </Button>
              <Button
                variant="outline"
                onClick={onClearCustomRange}
                className="rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                type="button"
              >
                Clear
              </Button>
            </div>
            {customRangeError ? <p className="text-xs text-rose-500">{customRangeError}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} className="rounded-full border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
