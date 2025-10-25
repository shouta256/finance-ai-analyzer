"use client";

import { useState, useTransition } from "react";
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
        setMessage("連携解除中…");
        await resetTransactions({ unlinkPlaid: true });
        setMessage("連携を解除しました。");
      } catch (e) {
        setMessage((e as Error).message || "解除に失敗しました");
      }
    });
  };

  const handleReset = () => {
    if (!confirm("全ての取引データを削除します。続行しますか？")) return;
    startTransition(async () => {
      try {
        setMessage("データ削除を実行中…");
        await resetTransactions();
        setMessage("取引データを削除しました。");
      } catch (e) {
        setMessage((e as Error).message || "削除に失敗しました");
      }
    });
  };

  const handleRelink = () => {
    startTransition(async () => {
      try {
        setMessage("Plaid Link を起動中…");
        const { linkToken } = await createPlaidLinkToken();
        const plaid = await loadPlaidLink();
        const handler = plaid.create({
          token: linkToken,
          onSuccess: () => {
            setMessage("再連携が完了しました。ダッシュボードで同期してください。");
            handler.destroy?.();
          },
          onExit: () => handler.destroy?.(),
        });
        handler.open();
      } catch (e) {
        setMessage((e as Error).message || "再連携に失敗しました");
      }
    });
  };

  const handleClearChat = () => {
    if (!confirm("チャット履歴を全て削除します。よろしいですか？")) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat", { method: "DELETE" });
        if (!res.ok) throw new Error("削除に失敗しました");
        setMessage("チャット履歴を削除しました。");
      } catch (e) {
        setMessage((e as Error).message || "削除に失敗しました");
      }
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold">アカウント設定</h1>
      <div className="space-y-4">
        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">セッション</h2>
          <button className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60" disabled={pending} onClick={handleLogout}>
            ログアウト
          </button>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">連携アカウント（Plaid）</h2>
          <div className="flex gap-3">
            <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleUnlink}>
              連携解除
            </button>
            <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleRelink}>
              再連携
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">データリセット</h2>
          <button className="rounded bg-white px-4 py-2 ring-1 ring-rose-300 disabled:opacity-60" disabled={pending} onClick={handleReset}>
            全取引データを削除
          </button>
        </section>

        <section className="rounded-xl border border-slate-200 p-4">
          <h2 className="mb-2 font-medium">チャット</h2>
          <button className="rounded bg-white px-4 py-2 ring-1 ring-slate-300 disabled:opacity-60" disabled={pending} onClick={handleClearChat}>
            チャット履歴をクリア
          </button>
        </section>

        {message ? <p className="text-sm text-slate-600">{message}</p> : null}
      </div>
    </main>
  );
}

