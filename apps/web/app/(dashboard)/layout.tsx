import React from "react";
import Link from "next/link";
import { DashboardHeaderActions } from "@/components/dashboard/header-actions";
import { AiChatIcon } from "@/components/dashboard/ai-chat-icon";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-slate-500">Safepocket</span>
            <span className="text-lg font-semibold">Financial Trust Dashboard</span>
          </div>
          <div className="flex items-center gap-3">
            <DashboardHeaderActions />
          </div>
        </div>
      </div>
      <main className="mx-auto max-w-screen-2xl px-6 pb-14">{children}</main>
      <Link
        href="/chat"
        className="fixed bottom-6 right-6 flex h-16 w-16 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition-transform hover:scale-105 hover:bg-slate-800"
        aria-label="AI Chat"
      >
        <AiChatIcon className="h-8 w-8" />
      </Link>
    </div>
  );
}
