import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="w-full max-w-md rounded-3xl border border-slate-200/70 bg-white">
        <DialogHeader className="items-start">
          <DialogTitle className="text-lg font-semibold tracking-tight text-slate-900">Accounts & Sync</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Link accounts, trigger syncs, or load demo data for your dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
            <Label htmlFor="modalSyncStart" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Sync from
            </Label>
            <Input
              id="modalSyncStart"
              type="month"
              value={startMonth}
              onChange={(event) => onStartMonthChange(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            />
            <p className="mt-1 text-[11px] text-slate-500">Optional month to backfill when syncing.</p>
          </div>

          <Button
            onClick={onLinkPlaid}
            className="w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
            disabled={!canLink}
          >
            Link Accounts with Plaid
          </Button>
          <Button
            variant="outline"
            onClick={onSync}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-100 disabled:opacity-60"
            disabled={!canSync}
          >
            Sync Transactions
          </Button>
          <Button
            variant="outline"
            onClick={onGenerateAi}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-100 disabled:opacity-60"
            disabled={!canGenerateAi}
          >
            Generate AI Summary
          </Button>
          <Button
            variant="outline"
            onClick={onLoadDemo}
            className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-100 disabled:opacity-60"
            disabled={!canLoadDemo}
          >
            Try Demo Data
          </Button>

          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-3">
            <div className="flex items-center justify-between text-xs font-medium text-slate-600">
              <Label htmlFor="unlinkOnReset">Unlink Plaid on reset</Label>
              <Checkbox
                id="unlinkOnReset"
                checked={unlinkPlaid}
                onCheckedChange={(value) => onToggleUnlink(!!value)}
                className="border-slate-300"
              />
            </div>
            <Button
              variant="outline"
              onClick={onReset}
              className="mt-3 w-full rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-100 disabled:opacity-60"
              disabled={!canReset}
            >
              Reset Data
            </Button>
          </div>

          {message ? <p className="text-xs text-slate-500">{message}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
