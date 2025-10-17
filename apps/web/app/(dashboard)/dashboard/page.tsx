import { Suspense } from "react";
import dynamic from "next/dynamic";
import { currentYearMonth } from "@/src/lib/date";
import { getDashboardData } from "@/src/lib/dashboard-data";

const DashboardClient = dynamic(() => import("@/components/dashboard").then((mod) => mod.DashboardClient), {
  ssr: false,
});

interface DashboardPageProps {
  searchParams?: {
    month?: string;
  };
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const month = searchParams?.month ?? currentYearMonth();
  try {
    const { summary, transactions } = await getDashboardData(month);
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-100 py-10">
        <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-10 px-6">
          <Suspense fallback={<p className="text-sm text-slate-500">Loading dashboard…</p>}>
            <DashboardClient month={month} initialSummary={summary} initialTransactions={transactions} />
          </Suspense>
        </div>
      </main>
    );
  } catch (error) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-100 py-10">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Safepocket Dashboard</h1>
          <p className="text-sm text-rose-600">
          {(error as Error).message ?? "Unable to load dashboard. Please authenticate and retry."}
          </p>
        </div>
      </main>
    );
  }
}
