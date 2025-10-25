import { NextRequest, NextResponse } from "next/server";
import { env } from "@/src/lib/env";

function resolveRedirect(target: string | null, origin: string): string {
  if (target) {
    try {
      const parsed = new URL(target, origin);
      if (parsed.origin === origin) {
        return parsed.toString();
      }
    } catch {
      if (target.startsWith("/")) {
        return `${origin}${target}`;
      }
    }
  }
  return `${origin}/dashboard`;
}

function createErrorRedirect(origin: string, message?: string) {
  const redirect = new URL("/login", origin);
  redirect.searchParams.set("authError", "1");
  if (message) {
    redirect.searchParams.set("message", message);
  }
  return NextResponse.redirect(redirect);
}

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    const proto = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (proto) {
      return proto === "https";
    }
  }
  return request.nextUrl.protocol === "https:";
}

export async function GET(request: NextRequest) {
  const API_BASE =
    env.SAFEPOCKET_API_BASE ||
    env.NEXT_PUBLIC_API_BASE ||
    process.env.COGNITO_GATEWAY_BASE ||
    process.env.API_GATEWAY_BASE;

  if (!API_BASE) {
    return createErrorRedirect(request.nextUrl.origin, "SAFEPOCKET_API_BASE (or equivalent) is not configured");
  }
  const nextUrl = request.nextUrl;
  const code = nextUrl.searchParams.get("code");
  if (!code) {
    return createErrorRedirect(nextUrl.origin, "Authorization code missing");
  }
  const state = nextUrl.searchParams.get("state");

const apiBaseUrl = API_BASE.endsWith("/") ? API_BASE : `${API_BASE}/`;
const upstreamUrl = new URL("auth/callback", apiBaseUrl);
  upstreamUrl.searchParams.set("code", code);
  upstreamUrl.searchParams.set("response", "json");
  if (state) upstreamUrl.searchParams.set("state", state);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: "GET",
      // Forward cookies only if present (not required but keeps parity).
      headers: request.headers.get("cookie")
        ? { cookie: request.headers.get("cookie") as string }
        : undefined,
    });
  } catch (error) {
    return createErrorRedirect(nextUrl.origin, (error as Error).message);
  }

  let payload: any = null;
  const text = await upstreamResponse.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!upstreamResponse.ok) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.error ||
      upstreamResponse.statusText ||
      "Authorization failed";
    return createErrorRedirect(nextUrl.origin, message);
  }

  const accessToken: string | undefined = payload?.accessToken ?? payload?.access_token ?? undefined;
  const idToken: string | undefined = payload?.idToken ?? payload?.id_token ?? undefined;
  const refreshToken: string | undefined = payload?.refreshToken ?? payload?.refresh_token ?? undefined;
  const expiresInRaw: number | undefined = payload?.expiresIn ?? payload?.expires_in;
  const expiresIn = expiresInRaw !== undefined && Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Math.floor(expiresInRaw) : 3600;

  const response = NextResponse.redirect(resolveRedirect(state, nextUrl.origin));
  const secureRequest = isSecureRequest(request);
  const sameSite = (secureRequest ? "none" : "lax") as "none" | "lax";
  const cookieOptions = {
    httpOnly: true,
    secure: secureRequest,
    sameSite,
    path: "/",
    maxAge: expiresIn,
  };

  if (accessToken) {
    response.cookies.set("sp_at", accessToken, cookieOptions);
  } else {
    response.cookies.delete("sp_at");
  }
  const primaryToken = idToken || accessToken;
  if (primaryToken) {
    response.cookies.set("sp_token", primaryToken, cookieOptions);
  } else {
    response.cookies.delete("sp_token");
  }
  if (idToken) {
    response.cookies.set("sp_it", idToken, cookieOptions);
  } else {
    response.cookies.delete("sp_it");
  }
  if (refreshToken) {
    response.cookies.set("sp_rt", refreshToken, {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60,
    });
  } else {
    response.cookies.delete("sp_rt");
  }

  return response;
}
