// middleware.ts (updated)
import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const AUTH_OPTIONAL =
  process.env.NEXT_PUBLIC_AUTH_OPTIONAL === 'true' ||
  process.env.AUTH_OPTIONAL === 'true';

// --- Public paths (no auth check) ---
function isPublicPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname === '/auth/callback' ||
    pathname === '/api/login/cognito/callback' ||
    pathname === '/api/auth/callback/cognito' ||
    pathname === '/api/auth/token' ||
    // dev-only helper login endpoint (allow in any env to avoid 401 in preview, internally guarded later)
    pathname.startsWith('/api/dev/login') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/api/healthz' ||
    pathname === '/api/actuator/health/liveness'
  );
}

// --- Rate limit only protected paths ---
function shouldRateLimit(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname) || req.method === 'OPTIONS') return false;
  if (pathname.startsWith('/api/')) return true; // all API routes are protected
  return true; // other pages are protected too
}

// --- Simple fixed-window rate limiter (swap with KV if needed) ---
const hits = new Map<string, { count: number; resetAt: number }>();
function takeTicket(key: string, limit = 60, windowSec = 60) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || rec.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true };
  }
  if (rec.count < limit) {
    rec.count++;
    return { ok: true };
  }
  return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
}

// --- JWT validation (Cognito first, then dev fallback) ---
// Priority: explicit COGNITO_* values → build from region + pool id → dev secret fallback
const REGION = process.env.COGNITO_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID; // Example: us-east-1_abc123
const EXPLICIT_ISSUER = process.env.COGNITO_ISSUER;
const EXPLICIT_JWKS = process.env.COGNITO_JWKS_URL;
const EXPLICIT_AUDIENCE = process.env.COGNITO_AUDIENCE; // Optional: comma-separated when multiple app clients
const CLIENT_ID = process.env.COGNITO_CLIENT_ID; // Cognito App Client ID (web)

let derivedIssuer = EXPLICIT_ISSUER || ((REGION && USER_POOL_ID) ? `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}` : undefined);
let issuer = derivedIssuer;
let jwksUri = EXPLICIT_JWKS || (issuer ? `${issuer}/.well-known/jwks.json` : undefined);
// Support multiple audiences via comma-separated env (e.g., WEB_CLIENT_ID,NATIVE_CLIENT_ID)
let allowedAudiences: string[] = (EXPLICIT_AUDIENCE || CLIENT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
// Back-compat single audience string (for debug headers only)
let audience = allowedAudiences[0];

const devSharedSecret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? 'dev-secret-key-for-local-development-only';
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function isHttpUrl(value?: string) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function verifyJwt(token: string): Promise<{ sub?: string; iss?: string; aud?: string | string[]; mode: string }> {
  // Dynamic fallback: if issuer or audience is missing, decode header to guess iss/aud
  if (!issuer || allowedAudiences.length === 0) {
    try {
      const [, payloadB64] = token.split('.');
      // Edge-safe base64url decode without Buffer
      const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const json = JSON.parse(atob(b64 + pad));
      if (typeof json.iss === 'string' && issuer !== json.iss) {
        issuer = json.iss;
        jwksUri = isHttpUrl(issuer) ? `${issuer}/.well-known/jwks.json` : undefined;
      }
      if (allowedAudiences.length === 0) {
        if (Array.isArray(json.aud)) allowedAudiences = json.aud.filter((x: unknown): x is string => typeof x === 'string');
        else if (typeof json.aud === 'string') allowedAudiences = [json.aud];
        // If aud is missing, try client_id as fallback (common for Cognito access tokens)
        if ((!allowedAudiences || allowedAudiences.length === 0) && typeof json.client_id === 'string') {
          allowedAudiences = [json.client_id];
        }
        audience = allowedAudiences[0];
      }
    } catch {
      // ignore – fallback to dev secret if still not resolvable
    }
  }

  if (jwksUri && issuer && isHttpUrl(jwksUri)) {
    remoteJwks ||= createRemoteJWKSet(new URL(jwksUri));
    if (allowedAudiences.length > 0) {
      try {
        const verified = await jwtVerify(token, remoteJwks, { issuer, audience: allowedAudiences });
        return { sub: verified.payload.sub as string | undefined, iss: verified.payload.iss as string | undefined, aud: (verified.payload.aud as any), mode: 'jwks+audi' };
      } catch (e: any) {
        // Audience mismatch fallback: retry with issuer only (avoids loops when audience is not set yet)
        if (e?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' || e?.message?.includes('audience')) {
          try {
            const verified2 = await jwtVerify(token, remoteJwks, { issuer });
            // Manual audience/client_id check against allowed list after issuer-only verification
            const payload = verified2.payload as any;
            const audClaim: string | string[] | undefined = payload?.aud;
            const clientIdClaim: string | undefined = payload?.client_id;
            const tokenUse: string | undefined = payload?.token_use;
            const audOk = Array.isArray(audClaim)
              ? audClaim.some((a) => allowedAudiences.includes(a))
              : typeof audClaim === 'string'
                ? allowedAudiences.includes(audClaim)
                : false;
            const clientOk = clientIdClaim && tokenUse === 'access' && allowedAudiences.includes(clientIdClaim);
            if (!audOk && !clientOk && allowedAudiences.length > 0) {
              throw new Error('invalid_audience');
            }
            return { sub: verified2.payload.sub as string | undefined, iss: verified2.payload.iss as string | undefined, aud: (verified2.payload.aud as any), mode: 'jwks-issuer-only' };
          } catch (inner) {
            // Non-production fallback: try dev shared secret to keep local flows working when Cognito is not ready
            if (process.env.NODE_ENV !== 'production') {
              try {
                const verifiedDev = await jwtVerify(token, new TextEncoder().encode(devSharedSecret));
                return { sub: verifiedDev.payload.sub as string | undefined, iss: verifiedDev.payload.iss as string | undefined, aud: (verifiedDev.payload.aud as any), mode: 'dev-fallback' };
              } catch {
                // ignore; propagate original error below
              }
            }
            throw inner; // propagate
          }
        }
        // Non-production fallback: try dev shared secret on other verify errors
        if (process.env.NODE_ENV !== 'production') {
          try {
            const verifiedDev = await jwtVerify(token, new TextEncoder().encode(devSharedSecret));
            return { sub: verifiedDev.payload.sub as string | undefined, iss: verifiedDev.payload.iss as string | undefined, aud: (verifiedDev.payload.aud as any), mode: 'dev-fallback' };
          } catch {
            // ignore; propagate original error below
          }
        }
        throw e;
      }
    } else {
      // Audience is empty → verify issuer only
      try {
        const verified = await jwtVerify(token, remoteJwks, { issuer });
        // If allowedAudiences configured, enforce it manually using aud or client_id
        if (allowedAudiences.length > 0) {
          const payload = verified.payload as any;
          const audClaim: string | string[] | undefined = payload?.aud;
          const clientIdClaim: string | undefined = payload?.client_id;
          const tokenUse: string | undefined = payload?.token_use;
          const audOk = Array.isArray(audClaim)
            ? audClaim.some((a) => allowedAudiences.includes(a))
            : typeof audClaim === 'string'
              ? allowedAudiences.includes(audClaim)
              : false;
          const clientOk = clientIdClaim && tokenUse === 'access' && allowedAudiences.includes(clientIdClaim);
          if (!audOk && !clientOk) {
            throw new Error('invalid_audience');
          }
        }
        return { sub: verified.payload.sub as string | undefined, iss: verified.payload.iss as string | undefined, aud: (verified.payload.aud as any), mode: 'jwks-no-aud' };
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          try {
            const verifiedDev = await jwtVerify(token, new TextEncoder().encode(devSharedSecret));
            return { sub: verifiedDev.payload.sub as string | undefined, iss: verifiedDev.payload.iss as string | undefined, aud: (verifiedDev.payload.aud as any), mode: 'dev-fallback' };
          } catch {
            // ignore; propagate original error below
          }
        }
        throw e;
      }
    }
  }
  // Dev fallback: verify with shared secret (no JWK)
  const encoder = new TextEncoder();
  const verified = await jwtVerify(token, encoder.encode(devSharedSecret));
  return { sub: verified.payload.sub as string | undefined, iss: verified.payload.iss as string | undefined, aud: (verified.payload.aud as any), mode: 'dev-shared-secret' };
}

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  // Force migration: ignore legacy safepocket_token to trigger a fresh login
  const sp = req.cookies.get('sp_token')?.value;
  if (sp) return sp;
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1) Allow preflight requests
  if (req.method === 'OPTIONS') return NextResponse.next();

  // 2) Allow public paths without checks
  if (isPublicPath(pathname)) return NextResponse.next();

  // 3) Apply rate limit when needed
  if (shouldRateLimit(req)) {
    const fwd = req.headers.get('x-forwarded-for') ?? '';
    const clientIp = fwd.split(',')[0].trim() || (req as any).ip || 'unknown';
    const key = `${clientIp}:${req.method}:${pathname}`;
    const ticket = takeTicket(key, 60, 60);
    if (!ticket.ok) {
      const res = new Response('Too Many Requests', { status: 429 });
      if (ticket.retryAfter) res.headers.set('Retry-After', String(ticket.retryAfter));
      return res;
    }
  }

  // 4) Resolve token from Authorization header or cookie
  const token = extractToken(req);
  if (!token) {
    if (AUTH_OPTIONAL) {
      return NextResponse.next();
    }
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing token' } }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname || '/dashboard');
    const res = NextResponse.redirect(url);
    if (req.headers.get('x-forwarded-proto') === 'http') {
      res.headers.set('x-auth-hint', 'missing-token-proto-http');
    }
    return res;
  }

  try {
    const { sub, iss, aud, mode } = await verifyJwt(token);
    if (!sub) throw new Error('Missing subject');
    if (pathname.startsWith('/login')) {
      const url = req.nextUrl.clone();
      url.pathname = '/dashboard';
      url.searchParams.delete('redirect');
      return NextResponse.redirect(url);
    }
    const h = new Headers(req.headers);
    h.set('x-safepocket-user-id', sub);
    if (iss) h.set('x-safepocket-iss', iss);
    if (aud) h.set('x-safepocket-aud', Array.isArray(aud) ? aud[0] : aud);
    h.set('x-safepocket-auth-mode', mode);
    if (!h.has('authorization')) h.set('authorization', `Bearer ${token}`);
    return NextResponse.next({ request: { headers: h } });
  } catch (e) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: (e as Error).message } }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    // Debug headers (safe for production) show the last failure reason
    const res = NextResponse.redirect(url);
    res.headers.set('x-auth-error', (e as Error).message);
    res.headers.set('x-auth-issuer', issuer || '');
    res.headers.set('x-auth-audience', audience || '');
    res.headers.set('x-auth-jwks', jwksUri || '');
    return res;
  }
}

// Exclude static files via matcher for safety
export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|robots\\.txt|api/healthz|api/actuator/health/liveness).*)',
  ],
};
