import { NextRequest, NextResponse } from 'next/server';

/*
 * Cognito Hosted UI redirect URI endpoint.
 * Exchanges authorization code for tokens then sets safepocket_token cookie (ID or Access token depending on config).
 * Fallback: returns 400 if required env vars missing.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || '/dashboard';

  const region = process.env.COGNITO_REGION;
  const userPoolDomain = process.env.COGNITO_DOMAIN; // e.g. your-domain.auth.us-east-1.amazoncognito.com
  const clientId = process.env.COGNITO_CLIENT_ID;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET; // optional (if app client secret enabled)
  const redirectUri = process.env.COGNITO_REDIRECT_URI || `${req.nextUrl.origin}/auth/callback`;

  if (!code || !userPoolDomain || !clientId || !redirectUri) {
    return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Missing code or Cognito configuration' } }, { status: 400 });
  }

  try {
    const basicAuth = clientSecret ? Buffer.from(`${clientId}:${clientSecret}`).toString('base64') : undefined;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
    });

    const tokenEndpoint = `https://${userPoolDomain}/oauth2/token`;
    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(basicAuth ? { Authorization: `Basic ${basicAuth}` } : {}),
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json({ error: { code: 'TOKEN_EXCHANGE_FAILED', message: text } }, { status: resp.status });
    }

    const json = await resp.json();
    // Choose which token to store: prefer id_token (identity claims), fallback access_token
    const token = json.id_token || json.access_token;
    if (!token) {
      return NextResponse.json({ error: { code: 'NO_TOKEN', message: 'No id/access token returned' } }, { status: 500 });
    }

    const redirectTarget = safeRedirectPath(state);

    const res = NextResponse.redirect(new URL(redirectTarget, req.nextUrl.origin));
    // Cookie scopes entire app domain; secure should be true in production with HTTPS
    res.cookies.set('safepocket_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      path: '/',
      maxAge: 3600, // 1h (Cognito token default 1h)
    });
    return res;
  } catch (e) {
    return NextResponse.json({ error: { code: 'EXCHANGE_ERROR', message: (e as Error).message } }, { status: 500 });
  }
}

function safeRedirectPath(raw: string): string {
  if (!raw.startsWith('/')) return '/dashboard';
  // Avoid open redirects – restrict to dashboard area for now
  if (!raw.startsWith('/dashboard')) return '/dashboard';
  return raw;
}
