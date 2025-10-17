import { ReactNode } from "react";

interface DashboardActionsModalProps {
  open: boolean;
  onClose: () => void;
  startMonth: string;
  onStartMonthChange: (value: string) => void;
  onLinkPlaid: () => void;
  onSync: () => void;
  onGenerateAi: () => void;
  onLoadDemo: () => void;
  onReset: () => void;
  canLink: boolean;
  canSync: boolean;
  canGenerateAi: boolean;
  canLoadDemo: boolean;
  canReset: boolean;
  unlinkPlaid: boolean;
  onToggleUnlink: (value: boolean) => void;
  message?: string | null;
}

export function DashboardActionsModal(props: DashboardActionsModalProps) {
  const {
    open,
    onClose,
    startMonth,
    onStartMonthChange,
    onLinkPlaid,
    onSync,
    onGenerateAi,
    onLoadDemo,
    onReset,
    canLink,
    canSync,
    canGenerateAi,
    canLoadDemo,
    canReset,
    unlinkPlaid,
    onToggleUnlink,
    message,
  } = props;

  if (!open) return null;

  return (
    <Backdrop onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-3xl border border-slate-200/70 bg-white p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">Accounts & Sync</h2>
            <p className="text-xs text-slate-500">Link accounts, trigger syncs, or load demo data.</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
            <label htmlFor="modalSyncStart" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Sync from
            </label>
            <input
              id="modalSyncStart"
              type="month"
              value={startMonth}
              onChange={(event) => onStartMonthChange(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400/60"
            />
            <p className="mt-1 text-[11px] text-slate-500">Optional month to backfill when syncing.</p>
          </div>

          <button
            onClick={onLinkPlaid}
            className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
            disabled={!canLink}
          >
            Link Accounts with Plaid
          </button>
          <button
            onClick={onSync}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
            disabled={!canSync}
          >
            Sync Transactions
          </button>
          <button
            onClick={onGenerateAi}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
            disabled={!canGenerateAi}
          >
            Generate AI Summary
          </button>
          <button
            onClick={onLoadDemo}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
            disabled={!canLoadDemo}
          >
            Try Demo Data
          </button>

          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
            <label className="flex items-center justify-between text-xs font-medium text-slate-600">
              <span>Unlink Plaid on reset</span>
              <input
                type="checkbox"
                checked={unlinkPlaid}
                onChange={(event) => onToggleUnlink(event.target.checked)}
              />
            </label>
            <button
              onClick={onReset}
              className="mt-3 w-full rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-60"
              disabled={!canReset}
            >
              Reset Data
            </button>
          </div>

          {message ? <p className="text-xs text-slate-500">{message}</p> : null}
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8"
      onClick={onClose}
    >
      {children}
    </div>
  );
}
