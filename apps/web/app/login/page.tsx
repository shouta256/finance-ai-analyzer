"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

const cognitoConfig = {
  domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN, // e.g. your-domain.auth.us-east-1.amazoncognito.com
  clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  redirectUri: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI || (typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : ''),
  scope: process.env.NEXT_PUBLIC_COGNITO_SCOPE || 'openid profile email',
};

const cognitoEnabled = Boolean(cognitoConfig.domain && cognitoConfig.clientId);
const authDebug = process.env.NEXT_PUBLIC_AUTH_DEBUG === 'true';
const devLoginAllowed =
  process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true' || process.env.NODE_ENV !== 'production';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleDevLogin = () => {
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

  const handleCognito = () => {
    if (!cognitoEnabled) return;
    setMessage(null);
    // Build Hosted UI authorize URL (Authorization Code Flow)
    const params = new URLSearchParams({
      client_id: cognitoConfig.clientId!,
      response_type: 'code',
      scope: cognitoConfig.scope,
      redirect_uri: cognitoConfig.redirectUri,
      state: searchParams.get("redirect") || '/dashboard',
    });
    const authorizeUrl = `https://${cognitoConfig.domain}/oauth2/authorize?${params.toString()}`;
    window.location.href = authorizeUrl;
  };

  // Auto redirect to Cognito in production when enabled and dev login not explicitly allowed
  useEffect(() => {
    if (cognitoEnabled && process.env.NODE_ENV === 'production' && !devLoginAllowed) {
      handleCognito();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoEnabled, devLoginAllowed]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-500">Safepocket</p>
          <h1 className="text-2xl font-semibold text-slate-800">ログイン</h1>
          {cognitoEnabled ? (
            <p className="mt-2 text-sm text-slate-500">
              Cognito アカウントでサインインできます。
              {devLoginAllowed ? ' 開発用のデモログインも利用可能です。' : ' 本番ではデモログインは無効化されています。'}
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">デモユーザーでダッシュボードを確認できます。本番環境では Cognito を有効化してください。</p>
          )}
        </div>
        {cognitoEnabled && (
          <button
            type="button"
            onClick={handleCognito}
            className="mb-3 w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Cognito でサインイン
          </button>
        )}
        {authDebug && (
          <div className="mb-3 rounded border border-indigo-200 bg-indigo-50 p-3 text-[10px] leading-relaxed text-slate-700">
            <p className="font-semibold mb-1">[Auth Debug]</p>
            <p>cognitoEnabled: {String(cognitoEnabled)}</p>
            <p>domain: {cognitoConfig.domain}</p>
            <p>clientId: {cognitoConfig.clientId}</p>
            <p>redirectUri: {cognitoConfig.redirectUri}</p>
            <p>scope: {cognitoConfig.scope}</p>
            <p className="break-all">authorizeURL (click to open):</p>
            <button
              type="button"
              onClick={() => {
                if (!cognitoEnabled) return;
                const params = new URLSearchParams({
                  client_id: cognitoConfig.clientId!,
                  response_type: 'code',
                  scope: cognitoConfig.scope,
                  redirect_uri: cognitoConfig.redirectUri,
                  state: '/dashboard',
                });
                const url = `https://${cognitoConfig.domain}/oauth2/authorize?${params.toString()}`;
                window.open(url, '_blank');
              }}
              className="mt-1 truncate rounded bg-white px-2 py-1 text-left font-mono text-[10px] shadow-sm hover:bg-slate-100"
            >
              https://{cognitoConfig.domain}/oauth2/authorize?... (open)
            </button>
          </div>
        )}
        {!cognitoEnabled && process.env.NODE_ENV === 'production' && (
          <p className="mb-3 rounded bg-amber-50 p-3 text-xs text-amber-700">
            Cognito が無効です。以下の環境変数を設定してください:<br />
            未設定: { !cognitoConfig.domain && 'NEXT_PUBLIC_COGNITO_DOMAIN '}{ !cognitoConfig.clientId && 'NEXT_PUBLIC_COGNITO_CLIENT_ID '}
          </p>
        )}
        {devLoginAllowed && (
          <>
            <button
              type="button"
              onClick={handleDevLogin}
              disabled={isPending}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isPending ? "ログイン中..." : "デモユーザーでログイン"}
            </button>
            <p className="mt-4 text-xs text-slate-500">
              {process.env.NODE_ENV === 'production'
                ? '本番環境でデモログインを表示するには NEXT_PUBLIC_ENABLE_DEV_LOGIN=true を設定してください。'
                : '開発環境: dev secret が無い場合は /api/dev/login で 403 になります。'}
            </p>
          </>
        )}
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
