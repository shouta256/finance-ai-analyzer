"use client";

import { useEffect, useState, useTransition } from "react";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";

interface LoginFormConfig {
  domain?: string;
  clientId?: string;
  scope: string;
  configuredRedirect?: string;
  authDebug: boolean;
  showDevLogin: boolean;
  showCognito: boolean;
}

interface LoginFormClientProps {
  config: LoginFormConfig;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ? process.env.NEXT_PUBLIC_API_BASE.trim().replace(/\/+$/, "") : undefined;

function buildCognitoUrl(domain: string, path = ""): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  const hasProtocol = trimmed.startsWith("http://") || trimmed.startsWith("https://");
  const base = hasProtocol ? trimmed : `https://${trimmed}`;
  return `${base}${path}`;
}

function normalizeRedirectCandidate(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function deriveApiCallbackUri(base?: string): string | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${cleanedPath}/auth/callback`.replace(/\/{2,}/g, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function resolveRedirectUri(configured?: string): string {
  const normalizedConfigured = normalizeRedirectCandidate(configured);
  if (normalizedConfigured) return normalizedConfigured;
  const apiCallback = deriveApiCallbackUri(API_BASE);
  if (apiCallback) return apiCallback;
  if (typeof window !== "undefined") {
    return `${window.location.origin}/auth/callback`;
  }
  return "";
}

export default function LoginFormClient({ config }: LoginFormClientProps) {
  const { domain, clientId, scope, configuredRedirect, authDebug, showDevLogin, showCognito } = config;
  const cognitoEnabled = Boolean(domain && clientId);
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const suppressAutoLaunch = searchParams?.get("authError") === "1";

  const handleDevLogin = () => {
    startTransition(async () => {
      setMessage(null);
      const raw = searchParams.get("redirect");
      const redirectTo: Route = (raw && raw.startsWith("/dashboard") ? raw : "/dashboard") as Route;
      const url = new URL("/api/dev/login", window.location.origin);
      url.searchParams.set("redirect", redirectTo);
      window.location.href = url.toString();
    });
  };

  const handleCognito = () => {
    if (!cognitoEnabled || !domain || !clientId) {
      setMessage("Cognito configuration is incomplete.");
      return;
    }
    setMessage(null);
    const redirectUri = resolveRedirectUri(configuredRedirect);
    if (!redirectUri) {
      setMessage("Unable to resolve redirect URI. Please configure NEXT_PUBLIC_API_BASE.");
      return;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("authError");
      window.history.replaceState({}, "", url.toString());
    } catch {
      // ignore history errors in non-browser contexts
    }
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope,
      redirect_uri: redirectUri,
      state: searchParams.get("redirect") || "/dashboard",
    });
    const authorizeUrl = buildCognitoUrl(domain, "/oauth2/authorize") + `?${params.toString()}`;
    window.location.href = authorizeUrl;
  };

  useEffect(() => {
    if (cognitoEnabled && showCognito && !suppressAutoLaunch) {
      handleCognito();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cognitoEnabled, showCognito, suppressAutoLaunch]);

  const debugEnabled = authDebug || searchParams.get("authdebug") === "1";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-wide text-slate-500">Safepocket</p>
          <h1 className="text-2xl font-semibold text-slate-800">Log in</h1>
          {showDevLogin ? (
            <p className="mt-2 text-sm text-slate-500">
              You can check the dashboard with the demo user. Please enable Cognito in production.
            </p>
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
        {debugEnabled && showCognito && (
          <div className="mb-3 rounded border border-indigo-200 bg-indigo-50 p-3 text-[10px] leading-relaxed text-slate-700">
            <p className="mb-1 font-semibold">[Auth Debug]</p>
            <p>cognitoEnabled: {String(cognitoEnabled)}</p>
            <p>domain: {domain || "(missing)"}</p>
            <p>apiBase: {API_BASE || "(missing)"}</p>
            <p>clientId: {clientId || "(missing)"}</p>
            <p>configured redirectUri: {configuredRedirect || "(none)"}</p>
            <p>computed redirectUri: {resolveRedirectUri(configuredRedirect)}</p>
            <p>scope: {scope}</p>
          </div>
        )}
        {showCognito && !cognitoEnabled && (
          <p className="mb-3 rounded bg-amber-50 p-3 text-xs text-amber-700">
            Cognito is disabled. Set COGNITO_DOMAIN / COGNITO_CLIENT_ID (or NEXT_PUBLIC_*) in your environment.
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
