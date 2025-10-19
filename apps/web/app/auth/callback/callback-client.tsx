"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setAuthTokens, clearAuthTokens } from "@/src/lib/auth-storage";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const APP_ENV = process.env.NEXT_PUBLIC_ENV ?? "";

export default function CallbackClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState("Authorizing...");
  const onceRef = useRef(false);

  const state = useMemo(() => {
    const raw = searchParams?.get("state");
    if (raw && raw.startsWith("/")) return raw;
    return "/dashboard";
  }, [searchParams]);

  useEffect(() => {
    if (onceRef.current) return;
    onceRef.current = true;

    if (!API_BASE) {
      fail("API base URL is not configured. Please contact support.");
      return;
    }

    const env = (APP_ENV || "").toLowerCase();
    if (env && env !== "prod" && env !== "production") {
      fail("API access is disabled in this environment.");
      return;
    }

    const code = searchParams?.get("code") ?? undefined;
    if (!code) {
      fail("Missing authorization code. Please log in again.");
      router.replace(`/login?redirect=${encodeURIComponent(state)}`);
      return;
    }

    const controller = new AbortController();

    async function exchange(codeValue: string) {
      try {
        setStatus("pending");
        setMessage("Exchanging authorization code...");
        const url = buildApiUrl("/auth/callback");
        url.searchParams.set("code", codeValue);
        url.searchParams.set("response", "json");
        url.searchParams.set("state", state);

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json", "cache-control": "no-store" },
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await safeJson(response);
          throw new Error(payload?.error?.message || response.statusText);
        }
        const payload = await response.json();
        setAuthTokens({
          accessToken: payload.accessToken ?? payload.idToken,
          idToken: payload.idToken,
          refreshToken: payload.refreshToken,
          expiresIn: payload.expiresIn,
        });
        setStatus("success");
        setMessage("Authenticated successfully. Redirecting...");
        router.replace(state);
      } catch (error) {
        console.error("[auth/callback] token exchange failed", error);
        clearAuthTokens();
        fail(error instanceof Error && error.message ? error.message : "Failed to authorize. Please try signing in again.");
      }
    }

    exchange(code);
    return () => controller.abort();

    function fail(msg: string) {
      clearAuthTokens();
      setStatus("error");
      setMessage(msg);
    }
  }, [router, searchParams, state]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-lg">
        <h1 className="text-xl font-semibold text-slate-800">Connecting to Safepocket</h1>
        <p className="mt-3 text-sm text-slate-600">{message}</p>
        {status === "error" ? (
          <div className="mt-6 space-y-3 text-sm text-slate-600">
            <p>If this problem persists, please relaunch the login flow.</p>
            <button
              type="button"
              onClick={() => router.replace(`/login?redirect=${encodeURIComponent(state)}`)}
              className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-indigo-500"
            >
              Back to Login
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function buildApiUrl(path: string): URL {
  const base = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${base}${normalisedPath}`);
}
