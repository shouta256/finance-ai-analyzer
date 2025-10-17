import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from "chart.js";
import type { ChartData, ChartOptions } from "chart.js";
import { Doughnut, Line } from "react-chartjs-2";

ChartJS.register(
  ArcElement,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
);

interface ChartsSectionProps {
  categoryData: ChartData<"doughnut"> | null;
  categoryOptions: ChartOptions<"doughnut">;
  trendData: ChartData<"line"> | null;
  trendOptions: ChartOptions<"line">;
}

export function ChartsSection({ categoryData, categoryOptions, trendData, trendOptions }: ChartsSectionProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-h-[280px] rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Spending mix</h2>
        <p className="text-sm text-slate-500">Category distribution for the current view.</p>
        <div className="mt-4 h-56">
          {categoryData ? (
            <Doughnut data={categoryData} options={categoryOptions} />
          ) : (
            <p className="text-sm text-slate-500">Not enough category data yet.</p>
          )}
        </div>
      </div>
      <div className="min-h-[280px] rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Net trend</h2>
        <p className="text-sm text-slate-500">Monthly net movement based on the selected period.</p>
        <div className="mt-4 h-56">
          {trendData ? (
            <Line data={trendData} options={trendOptions} />
          ) : (
            <p className="text-sm text-slate-500">Add more transactions or expand the range to see a trend.</p>
          )}
        </div>
      </div>
    </div>
  );
}
