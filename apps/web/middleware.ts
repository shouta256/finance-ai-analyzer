// middleware.ts (updated)
import { NextRequest, NextResponse } from 'next/server';

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

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('invalid_token');
  }
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const decoder = globalThis.atob ?? (() => {
    throw new Error('atob not available');
  });
  const binary = decoder(padded);
  const json = decodeURIComponent(
    Array.from(binary)
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join(''),
  );
  return JSON.parse(json);
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
    const payload = decodeJwt(token);
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    const iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    const audValue = (payload as any).aud;
    const aud = Array.isArray(audValue) ? audValue[0] : typeof audValue === 'string' ? audValue : undefined;
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
    if (aud) h.set('x-safepocket-aud', aud);
    h.set('x-safepocket-auth-mode', 'decoded');
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
    res.headers.set('x-auth-issuer', '');
    res.headers.set('x-auth-audience', '');
    return res;
  }
}

// Exclude static files via matcher for safety
export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|robots\\.txt|api/healthz|api/actuator/health/liveness).*)',
  ],
};
