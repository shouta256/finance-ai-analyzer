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

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/api/healthz" ||
    pathname === "/api/actuator/health/liveness" // proxy / future
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (process.env.NODE_ENV === "development" && pathname.startsWith("/api/dev/login")) {
    return NextResponse.next();
  }

  if (!rateLimit(request)) {
    return NextResponse.json({ error: { code: "RATE_LIMIT", message: "Too many requests" } }, { status: 429 });
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = extractToken(request);
  if (!token) {
    // API vs Page handling
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname || "/dashboard");
    return NextResponse.redirect(loginUrl);
  }

  try {
    const { sub } = await verifyJwt(token);
    if (!sub) throw new Error("Missing subject claim");

    // Avoid redirect loop: if authenticated user hits /login redirect to dashboard
    if (pathname === "/login") {
      const url = new URL("/dashboard", request.url);
      return NextResponse.redirect(url);
    }
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set("x-safepocket-user-id", sub);
    if (!forwardedHeaders.has("authorization")) {
      forwardedHeaders.set("authorization", `Bearer ${token}`);
    }
    return NextResponse.next({ request: { headers: forwardedHeaders } });
  } catch (e) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: (e as Error).message } }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  // Apply to all except explicitly ignored (handled in isPublicPath). Negative lookahead excludes healthz for perf.
  matcher: ['/((?!api/healthz|_next/|favicon\\.ico|robots\\.txt).*)'],
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
  const xfwd = request.headers.get("x-forwarded-for");
  const ip = xfwd?.split(",")[0]?.trim() || request.ip || "anonymous";
  const key = ip;
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
