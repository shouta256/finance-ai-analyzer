"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createPlaidLinkToken, resetTransactions } from "@/src/lib/client-api";
import { loadPlaidLink } from "@/src/lib/plaid";

export default function SettingsPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleLogout = () => {
    window.location.href = "/logout";
  };

  const handleUnlink = () => {
    startTransition(async () => {
      try {
        setMessage("Unlinking account…");
        await resetTransactions({ unlinkPlaid: true });
        setMessage("Account unlinked successfully.");
      } catch (e) {
        setMessage((e as Error).message || "Failed to unlink account");
      }
    });
  };

  const handleReset = () => {
    if (!confirm("This will delete ALL transactions. Continue?")) return;
    startTransition(async () => {
      try {
        setMessage("Deleting data…");
        await resetTransactions();
        setMessage("Transactions deleted.");
      } catch (e) {
        setMessage((e as Error).message || "Failed to delete");
      }
    });
  };

  const handleRelink = () => {
    startTransition(async () => {
      try {
        setMessage("Launching Plaid Link…");
        const { linkToken } = await createPlaidLinkToken();
        const plaid = await loadPlaidLink();
        const handler = plaid.create({
          token: linkToken,
          onSuccess: () => {
            setMessage("Re-link completed. Please sync on the dashboard.");
            handler.destroy?.();
          },
          onExit: () => handler.destroy?.(),
        });
        handler.open();
      } catch (e) {
        setMessage((e as Error).message || "Failed to re-link");
      }
    });
  };

  const handleClearChat = () => {
    if (!confirm("Delete all chat history?")) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat", { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to clear chat");
        setMessage("Chat history cleared.");
      } catch (e) {
        setMessage((e as Error).message || "Failed to clear chat");
      }
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Account Settings</h1>
        <Link
          href="/dashboard"
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-100"
        >
          Back to Dashboard
        </Link>
      </div>
      <div className="space-y-4">
        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">Session</h2>
          <button className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60" disabled={pending} onClick={handleLogout}>
            Log out
          </button>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">Linked Accounts (Plaid)</h2>
          <div className="flex gap-3">
            <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleUnlink}>
              Unlink
            </button>
            <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleRelink}>
              Re-link
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">Data Reset</h2>
          <button className="rounded bg-white px-4 py-2 ring-1 ring-rose-300 disabled:opacity-60" disabled={pending} onClick={handleReset}>
            Delete all transactions
          </button>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">Chat</h2>
          <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleClearChat}>
            Clear chat history
          </button>
        </section>

        {message ? <p className="text-sm text-slate-600">{message}</p> : null}
      </div>
    </main>
  );
}
