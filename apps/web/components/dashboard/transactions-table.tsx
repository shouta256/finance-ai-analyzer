import { formatCurrency, formatDateTime } from "@/src/lib/date";
import type { TransactionsList } from "@/src/lib/dashboard-data";
import { useMemo } from "react";

interface TransactionsTableProps {
  transactions: TransactionsList["transactions"];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function TransactionsTable({ transactions, page, pageSize, onPageChange }: TransactionsTableProps) {
  const categoryStyles = useMemo(() => {
    const netByCategory = new Map<string, number>();
    const expenseByCategory = new Map<string, number>();

    for (const tx of transactions) {
      const netTotal = netByCategory.get(tx.category) ?? 0;
      netByCategory.set(tx.category, netTotal + tx.amount);

      if (tx.amount < 0) {
        const expenseTotal = expenseByCategory.get(tx.category) ?? 0;
        expenseByCategory.set(tx.category, expenseTotal + Math.abs(tx.amount));
      }
    }

    if (expenseByCategory.size === 0) {
      return new Map<string, { opacity: string; width: string; colorClass: string }>();
    }

    const logExpenseByCategory = new Map<string, number>();
    expenseByCategory.forEach((total, category) => {
      logExpenseByCategory.set(category, Math.log10(total + 1));
    });

    const maxLogExpense = Math.max(...logExpenseByCategory.values());

    const styles = new Map<string, { opacity: string; width: string; colorClass: string }>();

    for (const [category, net] of netByCategory.entries()) {
      let colorClass = "from-slate-400/80";
      if (net > 0) {
        colorClass = "from-emerald-400/80";
      } else if (net < 0) {
        colorClass = "from-rose-400/80";
      }

      let opacity = "opacity-100";
      let width = "w-12";

      if (net < 0 && maxLogExpense > 0) {
        const logExpense = logExpenseByCategory.get(category) ?? 0;
        const ratio = logExpense / maxLogExpense;

        let style = { opacity: "opacity-30", width: "w-4" };
        if (ratio >= 0.9) {
          style = { opacity: "opacity-100", width: "w-20" };
        } else if (ratio >= 0.7) {
          style = { opacity: "opacity-80", width: "w-12" };
        } else if (ratio >= 0.4) {
          style = { opacity: "opacity-60", width: "w-8" };
        }
        opacity = style.opacity;
        width = style.width;
      }

      styles.set(category, { opacity, width, colorClass });
    }
    return styles;
  }, [transactions]);

  return (
    <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Recent Transactions</h2>
        <span className="text-xs text-slate-500">Page {page + 1}</span>
      </div>
      <div className="flow-root">
        <table className="min-w-full text-sm">
          <thead className="text-left">
            <tr>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">Transaction</th>
              <th className="px-4 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">Category</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-500">
                Amount
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {transactions.map((transaction) => {
              const style = categoryStyles.get(transaction.category) ?? {
                opacity: "opacity-40",
                width: "w-4",
                colorClass: "from-slate-400/80",
              };
              return (
                <tr key={transaction.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60">
                  <td className="px-4 py-3.5 text-slate-800">
                    <div className="font-medium text-slate-800">{transaction.merchantName}</div>
                    <div className="text-xs text-slate-500">{formatDateTime(transaction.occurredAt)}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-slate-800">{transaction.category}</span>
                      <div
                        className={`h-0.5 rounded-full bg-gradient-to-r ${style.colorClass} to-transparent ${style.opacity} ${style.width}`}
                      />
                    </div>
                  </td>
                  <td
                    className={`px-4 py-3.5 text-right font-mono text-base font-medium ${
                      transaction.amount < 0 ? "text-rose-600" : "text-emerald-600"
                    }`}
                  >
                    {transaction.amount > 0 ? "+" : ""}
                    {formatCurrency(transaction.amount)}
                  </td>
                  <td className="px-4 py-3.5 text-center">
                    {transaction.pending ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                        Pending
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
                        Posted
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  No transactions yet. Run a sync to fetch activity.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={() => onPageChange(Math.max(page - 1, 0))}
          disabled={page === 0}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
        >
          Previous
        </button>
        <div className="text-xs text-slate-500">{Math.min(pageSize, transactions.length)} records</div>
        <button
          onClick={() => onPageChange(page + 1)}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Next
        </button>
      </div>
    </section>
  );
}