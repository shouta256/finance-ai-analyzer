"use client";

import { Suspense, useState, useTransition } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleLogin = () => {
    startTransition(async () => {
      setMessage(null);
      try {
        const response = await fetch("/api/dev/login", { method: "GET" });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error?.message ?? "ログインに失敗しました");
        }
  const raw = searchParams.get("redirect");
  // Only allow redirecting to /dashboard or its subpaths to keep typedRoutes happy and avoid open redirects
  const redirectTo: Route = (raw && raw.startsWith("/dashboard") ? raw : "/dashboard") as Route;
  router.replace(redirectTo);
      } catch (error) {
        setMessage((error as Error).message ?? "ログイン処理でエラーが発生しました");
      }
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-500">Safepocket</p>
          <h1 className="text-2xl font-semibold text-slate-800">開発用ログイン</h1>
          <p className="mt-2 text-sm text-slate-500">
            デモユーザーでダッシュボードを確認できます。本番環境では Cognito 認証を利用してください。
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogin}
          disabled={isPending}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isPending ? "ログイン中..." : "デモユーザーでログイン"}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          `.env.local` に `SAFEPOCKET_DEV_JWT_SECRET` を設定してから利用してください。
        </p>
        {message ? <p className="mt-4 text-sm text-rose-600">{message}</p> : null}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center text-slate-500">Loading…</div>}>
      <LoginForm />
    </Suspense>
  );
}
