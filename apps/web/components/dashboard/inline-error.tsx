interface InlineErrorProps {
  title: string;
  body: string;
  traceId?: string | null;
  onRetry: () => void;
  onDismiss: () => void;
  retryDisabled?: boolean;
}

export function InlineError({ title, body, traceId, onRetry, onDismiss, retryDisabled }: InlineErrorProps) {
  return (
    <div className="rounded-2xl border border-amber-200/80 bg-amber-50/70 p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold text-amber-900">{title}</div>
        <div className="text-xs text-amber-800">{body}</div>
        {traceId ? <div className="text-xs text-amber-600">Trace ID: {traceId}</div> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={onRetry}
            disabled={retryDisabled}
            className="rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700 disabled:opacity-60"
          >
            Retry
          </button>
          <button
            onClick={onDismiss}
            className="rounded-full border border-amber-300 px-4 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
