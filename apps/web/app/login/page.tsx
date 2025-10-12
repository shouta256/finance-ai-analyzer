"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";

// Build-time static parts of config (domain/clientId/scope). Redirect URI must be dynamic to avoid
// shipping a localhost callback into production bundles (causes redirect_mismatch in Hosted UI).
const cognitoStatic = {
  domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN, // e.g. your-domain.auth.us-east-1.amazoncognito.com
  clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  scope: process.env.NEXT_PUBLIC_COGNITO_SCOPE || 'openid profile email',
};

// Determine the redirect URI at runtime. If an env var is provided AND its host matches current
// window.location.host we use it; otherwise we fallback to current origin. This lets you keep
// NEXT_PUBLIC_COGNITO_REDIRECT_URI in local dev while production (different host) auto-corrects.
function resolveRedirectUri(): string {
  const configured = process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI;
  if (typeof window === 'undefined') return configured || '';
  const currentHost = window.location.host;
  const prodLike = !currentHost.startsWith('localhost') && !currentHost.startsWith('127.0.0.1');
  // 1. If configured and host matches current => use as-is
  if (configured) {
    try {
      const u = new URL(configured);
      if (u.host === currentHost) return configured;
      // 2. If we are on a production-like host but configured points to localhost => override
      const looksLocal = u.host.startsWith('localhost') || u.host.startsWith('127.0.0.1');
      if (prodLike && looksLocal) {
        return `${window.location.origin}/auth/callback`;
      }
  // 3. If we are on localhost and the value points to production we fall back to the current origin.
      if (!prodLike && !looksLocal) {
        return `${window.location.origin}/auth/callback`;
      }
    } catch {
      // ignore malformed; fallback below
    }
  }
  return `${window.location.origin}/auth/callback`;
}

const cognitoEnabled = Boolean(cognitoStatic.domain && cognitoStatic.clientId);
// Enable debug either via build-time flag or a query param (?authdebug=1) for production troubleshooting
const authDebugFlag = process.env.NEXT_PUBLIC_AUTH_DEBUG === 'true';
const envTag = process.env.NEXT_PUBLIC_ENV || (process.env.NODE_ENV === 'production' ? 'prod' : 'local');
const isProd = envTag === 'prod';
const showDevLogin = !isProd;
const showCognito = isProd;

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryDebug = searchParams.get('authdebug') === '1';
  const authDebug = authDebugFlag || queryDebug;
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleDevLogin = () => {
    startTransition(async () => {
      setMessage(null);
      const raw = searchParams.get("redirect");
      const redirectTo: Route = (raw && raw.startsWith("/dashboard") ? raw : "/dashboard") as Route;
      // Navigate to API so the browser processes Set-Cookie in a full navigation, then land on redirect target
      const url = new URL("/api/dev/login", window.location.origin);
      url.searchParams.set("redirect", redirectTo);
      window.location.href = url.toString();
    });
  };

  const handleCognito = () => {
    if (!cognitoEnabled) return;
    setMessage(null);
    // Build Hosted UI authorize URL (Authorization Code Flow)
    const redirectUri = resolveRedirectUri();
    const params = new URLSearchParams({
      client_id: cognitoStatic.clientId!,
      response_type: 'code',
      scope: cognitoStatic.scope,
      redirect_uri: redirectUri,
      state: searchParams.get("redirect") || '/dashboard',
    });
    const authorizeUrl = `https://${cognitoStatic.domain}/oauth2/authorize?${params.toString()}`;
    window.location.href = authorizeUrl;
  };

  // Auto redirect to Cognito in production when enabled and dev login not explicitly allowed
  useEffect(() => {
    if (cognitoEnabled && showCognito) {
      handleCognito();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoEnabled, showCognito]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-500">Safepocket</p>
          <h1 className="text-2xl font-semibold text-slate-800">Log in</h1>
          {showDevLogin ? (
            <p className="mt-2 text-sm text-slate-500">You can check the dashboard with the demo user. Please enable Cognito in production.</p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Please sign in with your Cognito account.</p>
          )}
        </div>
        {showCognito && cognitoEnabled && (
          <button
            type="button"
            onClick={handleCognito}
            className="mb-3 w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Sign in with Cognito
          </button>
        )}
        {authDebug && showCognito && (
          <div className="mb-3 rounded border border-indigo-200 bg-indigo-50 p-3 text-[10px] leading-relaxed text-slate-700">
            <p className="font-semibold mb-1">[Auth Debug]</p>
            <p>cognitoEnabled: {String(cognitoEnabled)}</p>
            <p>domain: {cognitoStatic.domain}</p>
            <p>clientId: {cognitoStatic.clientId}</p>
            <p>computed redirectUri: {resolveRedirectUri()}</p>
            {(() => {
              const val = resolveRedirectUri();
              const configured = process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI;
              if (configured && configured !== val) {
                return <p className="text-amber-700">[guard] configured ({configured}) → using ({val})</p>;
              }
              return null;
            })()}
            <p>scope: {cognitoStatic.scope}</p>
            <p className="break-all">authorizeURL (click to open):</p>
            <button
              type="button"
              onClick={() => {
                if (!cognitoEnabled) return;
                const redirectUri = resolveRedirectUri();
                const params = new URLSearchParams({
                  client_id: cognitoStatic.clientId!,
                  response_type: 'code',
                  scope: cognitoStatic.scope,
                  redirect_uri: redirectUri,
                  state: '/dashboard',
                });
                const url = `https://${cognitoStatic.domain}/oauth2/authorize?${params.toString()}`;
                window.open(url, '_blank');
              }}
              className="mt-1 truncate rounded bg-white px-2 py-1 text-left font-mono text-[10px] shadow-sm hover:bg-slate-100"
            >
              https://{cognitoStatic.domain}/oauth2/authorize?... (open)
            </button>
          </div>
        )}
        {showCognito && !cognitoEnabled && (
          <p className="mb-3 rounded bg-amber-50 p-3 text-xs text-amber-700">
            Cognito is disabled. Please set these variables:<br />
            Missing: { !cognitoStatic.domain && 'NEXT_PUBLIC_COGNITO_DOMAIN '}{ !cognitoStatic.clientId && 'NEXT_PUBLIC_COGNITO_CLIENT_ID '}
          </p>
        )}
        {showDevLogin && (
          <>
            <button
              type="button"
              onClick={handleDevLogin}
              disabled={isPending}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isPending ? "Signing in..." : "Log in as demo user"}
            </button>
            <p className="mt-4 text-xs text-slate-500">
              Note: in local development /api/dev/login returns 403 if the dev secret is missing.
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
    <Suspense fallback={<div className="p-6 text-center text-slate-500">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
