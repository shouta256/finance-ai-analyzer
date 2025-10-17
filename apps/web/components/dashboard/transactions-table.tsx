import { formatCurrency, formatDateTime } from "@/src/lib/date";
import type { TransactionsList } from "@/src/lib/dashboard-data";

interface TransactionsTableProps {
  transactions: TransactionsList["transactions"];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function TransactionsTable({ transactions, page, pageSize, onPageChange }: TransactionsTableProps) {
  return (
    <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Recent Transactions</h2>
        <span className="text-xs text-slate-500">Page {page + 1}</span>
      </div>
      <div className="flow-root overflow-hidden rounded-2xl border border-slate-100">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left font-semibold text-slate-600">Merchant</th>
              <th className="px-4 py-2 text-left font-semibold text-slate-600">Category</th>
              <th className="px-4 py-2 text-left font-semibold text-slate-600">Amount</th>
              <th className="px-4 py-2 text-left font-semibold text-slate-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {transactions.map((transaction) => (
              <tr key={transaction.id} className="hover:bg-slate-50/60">
                <td className="px-4 py-2 text-slate-700">
                  <div className="font-medium">{transaction.merchantName}</div>
                  <div className="text-xs text-slate-500">{formatDateTime(transaction.occurredAt)}</div>
                </td>
                <td className="px-4 py-2 text-slate-600">{transaction.category}</td>
                <td className="px-4 py-2 text-slate-600">{formatCurrency(transaction.amount)}</td>
                <td className="px-4 py-2 text-slate-600">{transaction.pending ? "Pending" : "Posted"}</td>
              </tr>
            ))}
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
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
