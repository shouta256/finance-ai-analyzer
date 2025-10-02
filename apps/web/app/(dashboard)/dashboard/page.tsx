import { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard-client";
import { currentYearMonth } from "@/src/lib/date";
import { getDashboardData } from "@/src/lib/dashboard-data";

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
      <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold">Safepocket Dashboard</h1>
          <p className="text-sm text-slate-600">
            Secure financial intelligence with Plaid sandbox connectivity.
          </p>
        </header>
        <Suspense fallback={<p className="text-sm text-slate-500">Loading dashboard…</p>}>
          <DashboardClient month={month} initialSummary={summary} initialTransactions={transactions} />
        </Suspense>
      </main>
    );
  } catch (error) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">Safepocket Dashboard</h1>
        <p className="text-sm text-rose-600">
          {(error as Error).message ?? "Unable to load dashboard. Please authenticate and retry."}
        </p>
      </main>
    );
  }
}
