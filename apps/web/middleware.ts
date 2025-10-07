// middleware.ts (updated)
import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// --- 公開パス定義（ここは完全素通し） ---
function isPublicPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname === '/auth/callback' ||
    pathname === '/api/login/cognito/callback' ||
    pathname === '/api/auth/callback/cognito' ||
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

// --- JWT 検証（Cognito 自動組立 + 既存ロジック） ---
// 優先順位: 明示的な COGNITO_ISSUER / _JWKS_URL / _AUDIENCE → region + user pool id から組み立て → dev secret fallback
const REGION = process.env.COGNITO_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID; // 例: us-east-1_abc123
const EXPLICIT_ISSUER = process.env.COGNITO_ISSUER;
const EXPLICIT_JWKS = process.env.COGNITO_JWKS_URL;
const EXPLICIT_AUDIENCE = process.env.COGNITO_AUDIENCE; // 任意: クライアントIDと異なる場合のみ
const CLIENT_ID = process.env.COGNITO_CLIENT_ID; // Cognito App Client ID

let derivedIssuer = EXPLICIT_ISSUER || ((REGION && USER_POOL_ID) ? `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}` : undefined);
let issuer = derivedIssuer;
let jwksUri = EXPLICIT_JWKS || (issuer ? `${issuer}/.well-known/jwks.json` : undefined);
let audience = EXPLICIT_AUDIENCE || CLIENT_ID; // 通常 audience=client_id

const devSharedSecret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? 'dev-secret-key-for-local-development-only';
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function verifyJwt(token: string): Promise<{ sub?: string; iss?: string; aud?: string }> {
  // 動的フォールバック: まだ issuer/audience 未決定ならヘッダ部を decode して iss/aud 推定
  if (!issuer || !audience) {
    try {
      const [, payloadB64] = token.split('.');
      const json = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      if (!issuer && typeof json.iss === 'string') {
        issuer = json.iss;
        jwksUri = `${issuer}/.well-known/jwks.json`;
      }
      if (!audience) {
        if (Array.isArray(json.aud)) audience = json.aud[0];
        else if (typeof json.aud === 'string') audience = json.aud;
      }
    } catch {
      // ignore – fallback to dev secret if still not resolvable
    }
  }

  if (jwksUri && issuer && audience) {
    remoteJwks ||= createRemoteJWKSet(new URL(jwksUri));
    const verified = await jwtVerify(token, remoteJwks, { issuer, audience });
    return { sub: verified.payload.sub as string | undefined, iss: verified.payload.iss as string | undefined, aud: (verified.payload.aud as any) };
  }
  // dev fallback
  const encoder = new TextEncoder();
  const verified = await jwtVerify(token, encoder.encode(devSharedSecret));
  return { sub: verified.payload.sub as string | undefined, iss: verified.payload.iss as string | undefined, aud: (verified.payload.aud as any) };
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
    const r = NextResponse.redirect(url);
    // 直前の callback で secure cookie がブラウザに保存されなかった場合の調査用
    if (req.headers.get('x-forwarded-proto') === 'http') {
      r.headers.set('x-auth-hint', 'missing-token-proto-http');
    }
    return r;
  }

  try {
    const { sub, iss, aud } = await verifyJwt(token);
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
    if (!h.has('authorization')) h.set('authorization', `Bearer ${token}`);
    return NextResponse.next({ request: { headers: h } });
  } catch (e) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: (e as Error).message } }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    // デバッグ用ヘッダ (本番で機微なし) – 末尾 1回の失敗理由を可視化
    const res = NextResponse.redirect(url);
    res.headers.set('x-auth-error', (e as Error).message);
    res.headers.set('x-auth-issuer', issuer || '');
    res.headers.set('x-auth-audience', audience || '');
    res.headers.set('x-auth-jwks', jwksUri || '');
    return res;
  }
}

// 静的は最初から matcher で外しておく（安全網）
export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|robots\\.txt|api/healthz|api/actuator/health/liveness).*)',
  ],
};
