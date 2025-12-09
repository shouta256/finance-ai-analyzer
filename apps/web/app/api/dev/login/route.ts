import { NextResponse, type NextRequest } from 'next/server';
import { SignJWT } from 'jose';

export const runtime = 'nodejs';

const DEV_USER_ID = '0f08d2b9-28b3-4b28-bd33-41a36161e9ab';
const PRIMARY_COOKIE = 'sp_token';
const ONE_HOUR_SECONDS = 60 * 60;

function shouldUseSecureCookie(req: NextRequest) {
  // In all non-production environments, prefer non-secure cookies to ensure local HTTP works
  if (process.env.NODE_ENV !== 'production') return false;

  const envFlag = process.env.SAFEPOCKET_DEV_COOKIE_SECURE;
  if (envFlag === 'true') return true;
  if (envFlag === 'false') return false;

  const hostHeader = req.headers.get('host') || '';
  const hostname = (hostHeader.split(':')[0] || req.nextUrl.hostname || '').toLowerCase();
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local');

  const forwardedProto = req.headers.get('x-forwarded-proto');
  if (forwardedProto === 'https') return true;
  if (forwardedProto === 'http') return false;

  const protocol = req.nextUrl.protocol.replace(':', '');
  if (protocol === 'https') return true;
  if (protocol === 'http') return false;

  // Default secure in production for non-local hosts
  return !isLocalHost;
}

function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.SAFEPOCKET_ENABLE_DEV_LOGIN === 'true' || process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true' || process.env.NEXT_PUBLIC_ENABLE_DEMO_LOGIN === 'true';
}

export async function GET(req: NextRequest) {
  if (!devLoginEnabled()) {
    return NextResponse.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Dev login disabled. Set SAFEPOCKET_ENABLE_DEV_LOGIN=true or NEXT_PUBLIC_ENABLE_DEV_LOGIN=true to permit demo access.',
        },
      },
      { status: 403 },
    );
  }

  // Prefer backend-minted token to ensure signature matches backend decoder
  const backend = process.env.LEDGER_SERVICE_URL ?? 'http://localhost:8081';
  try {
    const res = await fetch(`${backend}/dev/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: DEV_USER_ID }),
      // Do not forward cookies; this is a server-to-server call
      cache: 'no-store',
    });
    if (res.ok) {
      const json: any = await res.json();
      const token: string | undefined = json?.token;
      const ttl: number = Number(json?.expiresInSeconds ?? ONE_HOUR_SECONDS);
      if (token && typeof token === 'string') {
        const redirect = req.nextUrl.searchParams.get('redirect');
        const response = redirect
          ? NextResponse.redirect(new URL(redirect, req.nextUrl.origin), { status: 303 })
          : NextResponse.json({ ok: true, mode: 'backend' });
        const cookieInit = {
          httpOnly: true,
          secure: shouldUseSecureCookie(req),
          path: '/',
          sameSite: 'lax' as const,
          maxAge: ttl,
        };
        response.cookies.set(PRIMARY_COOKIE, token, cookieInit);
        // Set visible cookie for client-side demo detection
        response.cookies.set('sp_demo_mode', '1', { ...cookieInit, httpOnly: false });
        return response;
      }
    }
  } catch {
    // fall through to local mint
  }

  // Fallback: mint locally (requires matching SAFEPOCKET_DEV_JWT_SECRET across web and backend)
  const secret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? 'dev-secret-key-for-local-development-only';
  if (secret.length < 32) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_DEV_SECRET',
          message: 'SAFEPOCKET_DEV_JWT_SECRET must be at least 32 characters to mint HS256 tokens.',
        },
      },
      { status: 500 },
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: DEV_USER_ID, scope: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('safepocket-dev')
    .setAudience('safepocket-web')
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ONE_HOUR_SECONDS)
    .sign(new TextEncoder().encode(secret));

  const redirect = req.nextUrl.searchParams.get('redirect');
  const response = redirect
    ? NextResponse.redirect(new URL(redirect, req.nextUrl.origin), { status: 303 })
    : NextResponse.json({ ok: true, mode: 'local-fallback' }, { status: 200, headers: { 'x-dev-login-warning': 'backend-login-failed; ensure both apps share SAFEPOCKET_DEV_JWT_SECRET' } });
  const cookieInit = {
    httpOnly: true,
    secure: shouldUseSecureCookie(req),
    path: '/',
    sameSite: 'lax' as const,
    maxAge: ONE_HOUR_SECONDS,
  };
  response.cookies.set(PRIMARY_COOKIE, token, cookieInit);
  // Set visible cookie for client-side demo detection
  response.cookies.set('sp_demo_mode', '1', { ...cookieInit, httpOnly: false });
  return response;
}
