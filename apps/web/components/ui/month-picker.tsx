import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";

interface MonthPickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  minDate?: string;
  maxDate?: string;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function MonthPicker({ id, value, onChange, className }: MonthPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [openAbove, setOpenAbove] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  
  const currentDate = new Date();
  const [selectedYear, selectedMonth] = value 
    ? value.split("-").map(Number) 
    : [currentDate.getFullYear(), currentDate.getMonth() + 1];
  
  const [viewYear, setViewYear] = React.useState(selectedYear);

  React.useEffect(() => {
    if (isOpen) {
      setViewYear(selectedYear);
      // Check if dropdown would overflow below viewport
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const dropdownHeight = 320; // Approximate height of dropdown
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        setOpenAbove(spaceBelow < dropdownHeight && spaceAbove > spaceBelow);
      }
    }
  }, [isOpen, selectedYear]);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const formatDisplay = (y: number, m: number) => {
    return `${FULL_MONTHS[m - 1]} ${y}`;
  };

  const handleMonthSelect = (monthIndex: number) => {
    const newValue = `${viewYear}-${String(monthIndex + 1).padStart(2, "0")}`;
    onChange(newValue);
    setIsOpen(false);
  };

  const handlePrevYear = () => setViewYear((y) => y - 1);
  const handleNextYear = () => setViewYear((y) => y + 1);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        id={id}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-900/10",
          className
        )}
      >
        <Calendar className="h-4 w-4 text-slate-500" />
        <span>{value ? formatDisplay(selectedYear, selectedMonth) : "Select month"}</span>
        <svg 
          className={cn("h-4 w-4 text-slate-400 transition-transform", isOpen && "rotate-180")} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div 
          ref={dropdownRef}
          className={cn(
            "absolute left-0 z-50 w-64 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl animate-in fade-in-0 zoom-in-95 duration-150",
            openAbove ? "bottom-full mb-2" : "top-full mt-2"
          )}
        >
          {/* Year Navigation */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={handlePrevYear}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold text-slate-900">{viewYear}</span>
            <button
              type="button"
              onClick={handleNextYear}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Month Grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {MONTHS.map((monthName, idx) => {
              const isSelected = idx + 1 === selectedMonth && viewYear === selectedYear;
              const isCurrentMonth = idx + 1 === currentDate.getMonth() + 1 && viewYear === currentDate.getFullYear();
              return (
                <button
                  key={monthName}
                  type="button"
                  onClick={() => handleMonthSelect(idx)}
                  className={cn(
                    "rounded-lg px-2 py-2 text-xs font-medium transition-all",
                    isSelected
                      ? "bg-slate-900 text-white shadow-md"
                      : isCurrentMonth
                        ? "bg-slate-100 text-slate-900 ring-1 ring-slate-300"
                        : "text-slate-700 hover:bg-slate-100"
                  )}
                >
                  {monthName}
                </button>
              );
            })}
          </div>

          {/* Quick Actions */}
          <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => {
                const today = new Date();
                const newValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
                onChange(newValue);
                setIsOpen(false);
              }}
              className="flex-1 rounded-lg bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200"
            >
              This Month
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex-1 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
