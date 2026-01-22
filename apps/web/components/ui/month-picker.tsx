import * as React from "react";
import { cn } from "@/lib/utils";

interface MonthPickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  minDate?: string;
  maxDate?: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function MonthPicker({ id, value, onChange, className, minDate, maxDate }: MonthPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [year, month] = value ? value.split("-").map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
  
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => currentYear - 5 + i);

  const formatDisplay = (y: number, m: number) => {
    return `${MONTHS[m - 1]} ${y}`;
  };

  const handleMonthSelect = (selectedMonth: number) => {
    const newValue = `${year}-${String(selectedMonth).padStart(2, "0")}`;
    onChange(newValue);
    setIsOpen(false);
  };

  const handleYearChange = (newYear: number) => {
    const newValue = `${newYear}-${String(month).padStart(2, "0")}`;
    onChange(newValue);
  };

  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span>{value ? formatDisplay(year, month) : "Select month"}</span>
        <svg className="h-4 w-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
            <div className="mb-3">
              <select
                value={year}
                onChange={(e) => handleYearChange(Number(e.target.value))}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm font-semibold"
              >
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MONTHS.map((monthName, idx) => {
                const monthNum = idx + 1;
                const isSelected = monthNum === month;
                return (
                  <button
                    key={monthName}
                    type="button"
                    onClick={() => handleMonthSelect(monthNum)}
                    className={cn(
                      "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                      isSelected
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    )}
                  >
                    {monthName.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
