import { type NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateLimitStore = new Map<string, RateLimitEntry>();

const jwksUri = process.env.COGNITO_JWKS_URL;
const issuer = process.env.COGNITO_ISSUER;
const audience = process.env.COGNITO_AUDIENCE;
// Fallback to backend's default dev secret so local setup works out-of-the-box
const devSharedSecret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? "dev-secret-key-for-local-development-only";

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (process.env.NODE_ENV === "development" && pathname.startsWith("/api/dev/login")) {
    return NextResponse.next();
  }

  if (!rateLimit(request)) {
    return NextResponse.json({ error: { code: "RATE_LIMIT", message: "Too many requests" } }, { status: 429 });
  }

  const isApi = pathname.startsWith("/api/");
  const isLogin = pathname === "/login";
  const isRoot = pathname === "/";

  const token = extractToken(request);
  if (!token) {
    if (isApi) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } }, { status: 401 });
    }
    // Allow unauthenticated access to /login
    if (isLogin) {
      return NextResponse.next();
    }
    // Redirect any other protected page (e.g., /dashboard) to /login with intent to go to dashboard post-login
    const loginUrl = new URL("/login", request.url);
    const redirectTo = isRoot ? "/dashboard" : pathname;
    if (!loginUrl.searchParams.has("redirect")) {
      loginUrl.searchParams.set("redirect", redirectTo);
    }
    return NextResponse.redirect(loginUrl);
  }

  try {
    const { sub } = await verifyJwt(token);
    if (!sub) {
      throw new Error("Missing subject claim");
    }
    // If already authenticated and visiting /login or /, send to /dashboard
    if (isLogin || isRoot) {
      const url = new URL("/dashboard", request.url);
      return NextResponse.redirect(url);
    }
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set("x-safepocket-user-id", sub);
    if (!forwardedHeaders.has("authorization")) {
      forwardedHeaders.set("authorization", `Bearer ${token}`);
    }
    return NextResponse.next({ request: { headers: forwardedHeaders } });
  } catch (error) {
    // For API routes, respond with 401 JSON; otherwise, redirect to login
    if (isApi) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: (error as Error).message } }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    if (!loginUrl.searchParams.has("redirect")) {
      loginUrl.searchParams.set("redirect", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  // Protect dashboard and APIs; handle auth-aware routing for root and login
  matcher: ["/", "/login", "/dashboard/:path*", "/api/:path*"],
};

function extractToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  const cookieToken = request.cookies.get("safepocket_token");
  return cookieToken?.value ?? null;
}

async function verifyJwt(token: string): Promise<{ sub?: string }> {
  if (jwksUri && issuer && audience) {
    remoteJwks ||= createRemoteJWKSet(new URL(jwksUri));
    const verified = await jwtVerify(token, remoteJwks, { issuer, audience });
    return { sub: verified.payload.sub as string | undefined };
  }
  if (!devSharedSecret) {
    throw new Error("JWT verification not configured");
  }
  const encoder = new TextEncoder();
  const verified = await jwtVerify(token, encoder.encode(devSharedSecret));
  return { sub: verified.payload.sub as string | undefined };
}

function rateLimit(request: NextRequest): boolean {
  const now = Date.now();
  const key = request.ip ?? request.headers.get("x-forwarded-for") ?? "anonymous";
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count += 1;
  return true;
}
