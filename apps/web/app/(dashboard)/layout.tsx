interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Safepocket
            </span>
            <span className="text-lg font-semibold">Financial Trust Dashboard</span>
          </div>
          <div className="text-sm text-slate-500">Secure | AI assisted</div>
        </div>
      </div>
      {children}
    </div>
  );
}
