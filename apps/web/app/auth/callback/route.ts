import { NextRequest, NextResponse } from 'next/server';

/*
 * Cognito Hosted UI redirect URI endpoint.
 * Exchanges authorization code for tokens then sets safepocket_token cookie (ID or Access token depending on config).
 * Fallback: returns 400 if required env vars missing.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || '/dashboard';

  // Prefer backend vars; fallback to public ones if not defined (production frontend-only deploy case)
  const userPoolDomain = process.env.COGNITO_DOMAIN || process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET; // no public fallback for secret
  const configuredRedirect = process.env.COGNITO_REDIRECT_URI || process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI;
  // Base (raw) value: configured one or current origin callback
  const rawRedirect = configuredRedirect || `${req.nextUrl.origin}/auth/callback`;
  // Host safeguard: if we are accessed via a non-localhost host but the configured redirect points to localhost
  // (common when a build was produced with a local NEXT_PUBLIC_COGNITO_REDIRECT_URI), replace the host with request host.
  let redirectUri = rawRedirect;
  try {
    const parsed = new URL(rawRedirect);
    const incomingHost = req.nextUrl.host; // includes port if any
    const isProdLikeHost = !incomingHost.startsWith('localhost') && incomingHost !== '127.0.0.1';
    if (isProdLikeHost && parsed.host !== incomingHost) {
      // Only override when the configured value looks like a localhost while request host is prod-like
      const looksLocal = parsed.host.startsWith('localhost') || parsed.host.startsWith('127.0.0.1');
      if (looksLocal) {
        redirectUri = `${req.nextUrl.origin}/auth/callback`;
      }
    }
  } catch {
    // Fallback – ensure we always have a syntactically valid URL
    redirectUri = `${req.nextUrl.origin}/auth/callback`;
  }

  if (!code) {
    return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Missing authorization code' } }, { status: 400 });
  }
  if (!userPoolDomain || !clientId) {
    return NextResponse.json({ error: { code: 'CONFIG_MISSING', message: `Missing Cognito config (domain=${!!userPoolDomain}, clientId=${!!clientId})` } }, { status: 500 });
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
      if (text.includes('invalid_client')) {
        return NextResponse.json({
          error: {
            code: 'TOKEN_EXCHANGE_FAILED',
            message: text,
            hints: [
              'Check App Client ID matches exactly (no hidden whitespace).',
              'If the App Client has a secret, ensure COGNITO_CLIENT_SECRET is set in the deployment (NEXT_PUBLIC_* cannot hold the secret).',
              'If the App Client has NO secret, make sure it is configured as a public client (no client secret required).',
              'Verify token endpoint allowed grant types include authorization_code.',
              'Ensure redirect URI in App Client settings matches exactly the one used here: ' + redirectUri,
            ],
            configSnapshot: {
              domain: userPoolDomain,
              clientId: clientId?.slice(0,4) + '...' + clientId?.slice(-4),
              hasSecret: Boolean(clientSecret),
              redirectUri,
              configuredRedirect,
              rawRedirect,
            },
          }
        }, { status: resp.status });
      }
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
