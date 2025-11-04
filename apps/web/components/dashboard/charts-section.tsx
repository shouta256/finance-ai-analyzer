import { useMemo } from "react";
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
import type { Chart, ChartData, ChartOptions, Plugin } from "chart.js";
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

const centerTextPlugin: Plugin = {
  id: "centerText",
  afterDraw(chart) {
    const pluginOptions = (chart.options.plugins as any)?.centerText as { text?: string; subtext?: string; color?: string } | undefined;
    if (!pluginOptions?.text) return;
    const meta = chart.getDatasetMeta(0);
    const arc = meta?.data?.[0];
    if (!arc) return;
    const { x, y } = (arc as any) ?? {};
    if (typeof x !== "number" || typeof y !== "number") return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "600 20px 'Inter', sans-serif";
    ctx.fillStyle = pluginOptions.color || "#0f172a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pluginOptions.text, x, y - 4);
    if (pluginOptions.subtext) {
      ctx.font = "400 12px 'Inter', sans-serif";
      ctx.fillStyle = "#64748b";
      const maxWidth = chart.chartArea.width * 0.7;
      ctx.fillText(pluginOptions.subtext, x, y + 14, maxWidth);
    }
    ctx.restore();
  },
};

interface ChartsSectionProps {
  categoryData: ChartData<"doughnut"> | null;
  categoryOptions: ChartOptions<"doughnut">;
  trendData: ChartData<"line"> | null;
  trendOptions: ChartOptions<"line">;
  spendingScore: number;
  scoreLabel: string;
}
ChartJS.register(centerTextPlugin);

export function ChartsSection({ categoryData, categoryOptions, trendData, trendOptions, spendingScore, scoreLabel }: ChartsSectionProps) {
  const doughnutOptions = useMemo(() => {
    if (!categoryData) return categoryOptions;
    const color = spendingScore >= 70 ? "#16a34a" : spendingScore >= 40 ? "#f59e0b" : "#dc2626";
    return {
      ...categoryOptions,
      plugins: {
        ...categoryOptions.plugins,
        centerText: { text: `${Math.round(spendingScore)}`, subtext: scoreLabel, color },
      } as any,
    } satisfies ChartOptions<"doughnut">;
  }, [categoryOptions, categoryData, spendingScore, scoreLabel]);

  const createNetGradient = (chart: Chart, opacity: number) => {
    const { ctx, chartArea } = chart;
    if (!chartArea) {
      return `rgba(37,99,235,${opacity})`;
    }
    const gradient = ctx.createLinearGradient(chartArea.left, chartArea.bottom, chartArea.right, chartArea.top);
    gradient.addColorStop(0, `rgba(59,130,246,${opacity})`);
    gradient.addColorStop(0.5, `rgba(168,85,247,${opacity})`);
    gradient.addColorStop(1, `rgba(236,72,153,${opacity})`);
    return gradient;
  };

  const netChartData = useMemo(() => {
    if (!trendData) return null;
    return {
      ...trendData,
      datasets: trendData.datasets.map((dataset) => ({
        ...dataset,
        borderColor: (ctx: { chart: Chart }) => createNetGradient(ctx.chart, 0.95),
        backgroundColor: (ctx: { chart: Chart }) => createNetGradient(ctx.chart, 0.18),
        pointBackgroundColor: "#2563eb",
        pointBorderColor: "transparent",
      })),
    };
  }, [trendData]);

  const chartContainerClass = "mt-4 h-56 w-full overflow-hidden rounded-2xl bg-white/0";
  const chartStyle = { width: "100%", height: "100%" } as const;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-h-[280px] min-w-0 rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Spending mix</h2>
        <p className="text-sm text-slate-500">Category distribution for the current view.</p>
        <div className={chartContainerClass}>
          {categoryData ? (
            <Doughnut data={categoryData} options={doughnutOptions} style={chartStyle} />
          ) : (
            <p className="text-sm text-slate-500">Not enough category data yet.</p>
          )}
        </div>
      </div>
      <div className="min-h-[280px] min-w-0 rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Net trend</h2>
        <p className="text-sm text-slate-500">Monthly net movement based on the selected period.</p>
        <div className={chartContainerClass}>
          {netChartData ? (
            <Line data={netChartData} options={trendOptions} style={chartStyle} />
          ) : (
            <p className="text-sm text-slate-500">Add more transactions or expand the range to see a trend.</p>
          )}
        </div>
      </div>
    </div>
  );
}
