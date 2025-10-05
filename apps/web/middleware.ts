// middleware.ts (updated)
import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// --- 公開パス定義（ここは完全素通し） ---
function isPublicPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    // dev-only helper login endpoint (allow in any env to avoid 401 in preview, internally guarded later)
    pathname.startsWith('/api/dev/login') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/api/healthz' ||
    pathname === '/api/actuator/health/liveness'
  );
}

// --- レートリミット対象にしたいものだけ true ---
function shouldRateLimit(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname) || req.method === 'OPTIONS') return false;
  if (pathname.startsWith('/api/')) return true; // すべての API は対象
  return true; // その他=保護ページ想定
}

// --- 単純な固定ウィンドウ（必要ならKV等に置換） ---
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

// --- JWT 検証（既存ロジックを再利用） ---
const jwksUri = process.env.COGNITO_JWKS_URL;
const issuer = process.env.COGNITO_ISSUER;
const audience = process.env.COGNITO_AUDIENCE;
const devSharedSecret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? 'dev-secret-key-for-local-development-only';
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function verifyJwt(token: string): Promise<{ sub?: string }> {
  if (jwksUri && issuer && audience) {
    remoteJwks ||= createRemoteJWKSet(new URL(jwksUri));
    const verified = await jwtVerify(token, remoteJwks, { issuer, audience });
    return { sub: verified.payload.sub as string | undefined };
  }
  const encoder = new TextEncoder();
  const verified = await jwtVerify(token, encoder.encode(devSharedSecret));
  return { sub: verified.payload.sub as string | undefined };
}

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return req.cookies.get('safepocket_token')?.value || null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1) プリフライトは無条件通過
  if (req.method === 'OPTIONS') return NextResponse.next();

  // 2) 公開パスも無条件通過（ここで return！）
  if (isPublicPath(pathname)) return NextResponse.next();

  // 3) レートリミット（対象のみ）
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

  // 4) Cookie / Authorization ヘッダで判定
  const token = extractToken(req);
  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Missing token' } }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname || '/dashboard');
    return NextResponse.redirect(url);
  }

  try {
    const { sub } = await verifyJwt(token);
    if (!sub) throw new Error('Missing subject');
    if (pathname.startsWith('/login')) {
      const url = req.nextUrl.clone();
      url.pathname = '/dashboard';
      url.searchParams.delete('redirect');
      return NextResponse.redirect(url);
    }
    const h = new Headers(req.headers);
    h.set('x-safepocket-user-id', sub);
    if (!h.has('authorization')) h.set('authorization', `Bearer ${token}`);
    return NextResponse.next({ request: { headers: h } });
  } catch (e) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: (e as Error).message } }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }
}

// 静的は最初から matcher で外しておく（安全網）
export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|robots\\.txt|api/healthz|api/actuator/health/liveness).*)',
  ],
};
