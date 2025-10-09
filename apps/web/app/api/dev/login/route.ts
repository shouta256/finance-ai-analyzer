import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';

export const runtime = 'nodejs';

const DEV_USER_ID = '0f08d2b9-28b3-4b28-bd33-41a36161e9ab';
const PRIMARY_COOKIE = 'sp_token';
const ONE_HOUR_SECONDS = 60 * 60;

function shouldUseSecureCookie() {
  const envFlag = process.env.SAFEPOCKET_DEV_COOKIE_SECURE;
  if (envFlag === 'true') return true;
  if (envFlag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.SAFEPOCKET_ENABLE_DEV_LOGIN === 'true' || process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true';
}

export async function GET() {
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

  const response = NextResponse.json({ ok: true, mode: 'local' });
  const cookieInit = {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    path: '/',
    sameSite: 'lax' as const,
    maxAge: ONE_HOUR_SECONDS,
  };
  response.cookies.set(PRIMARY_COOKIE, token, cookieInit);
  return response;
}
