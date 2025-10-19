import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/*
 * Cognito Hosted UI redirect URI endpoint.
 * Exchanges authorization code for tokens then sets safepocket_token cookie (ID or Access token depending on config).
 * Fallback: returns 400 if required env vars missing.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || '/dashboard';

  // Derive an "external" origin using forwarded headers (ECS / reverse proxy) to avoid 0.0.0.0 or container-internal hosts.
  const fwdHost = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto');
  const effectiveOrigin = fwdHost ? `${fwdProto || 'https'}://${fwdHost}` : req.nextUrl.origin;

  // Prefer backend vars; fallback to public ones if not defined (production frontend-only deploy case)
  const userPoolDomain = sanitizeEnv(process.env.COGNITO_DOMAIN || process.env.NEXT_PUBLIC_COGNITO_DOMAIN);
  const clientId = sanitizeEnv(process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID);
  const clientSecret = sanitizeEnv(process.env.COGNITO_CLIENT_SECRET);
  const configuredRedirect = sanitizeEnv(process.env.COGNITO_REDIRECT_URI || process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI);
  // Base (raw) value: configured one or current origin callback
  const rawRedirect = configuredRedirect || `${effectiveOrigin}/auth/callback`;
  // Host safeguard: if we are accessed via a non-localhost host but the configured redirect points to localhost
  // (common when a build was produced with a local NEXT_PUBLIC_COGNITO_REDIRECT_URI), replace the host with request host.
  let redirectUri = rawRedirect;
  try {
    const parsed = new URL(rawRedirect);
    // Use forwarded host if present (proxy) else request host
    const incomingHost = fwdHost || req.nextUrl.host; // includes port if any
    const isProdLikeHost = !incomingHost.startsWith('localhost') && incomingHost !== '127.0.0.1' && !incomingHost.startsWith('0.0.0.0');
    const isHttpScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!isHttpScheme) {
      // Custom scheme (e.g. native app). For web callback we override to current host to avoid mismatch.
      redirectUri = `${effectiveOrigin}/auth/callback`;
    } else if (isProdLikeHost && parsed.host !== incomingHost) {
      // Only override when the configured value looks like a localhost while request host is prod-like
      const looksLocal = parsed.host.startsWith('localhost') || parsed.host.startsWith('127.0.0.1') || parsed.host.startsWith('0.0.0.0');
      if (looksLocal) {
        redirectUri = `${effectiveOrigin}/auth/callback`;
      }
    }
  } catch {
    // Fallback – ensure we always have a syntactically valid URL
    redirectUri = `${effectiveOrigin}/auth/callback`;
  }

  if (!code) {
    return NextResponse.json({ error: { code: 'INVALID_REQUEST', message: 'Missing authorization code' } }, { status: 400 });
  }
  if (!userPoolDomain || !clientId) {
    return NextResponse.json({ error: { code: 'CONFIG_MISSING', message: `Missing Cognito config (domain=${!!userPoolDomain}, clientId=${!!clientId})` } }, { status: 500 });
  }

  try {
    const tokenResponse = await exchangeAuthorizationCode({
      domain: userPoolDomain,
      clientId,
      clientSecret,
      code,
      redirectUri,
    });

    const redirectTarget = safeRedirectPath(state);
    const forwardedProto = req.headers.get('x-forwarded-proto');
    const proto = forwardedProto || (req.nextUrl.protocol.replace(':', '')) || 'https';
    const secureCookie = proto === 'https';

    const res = NextResponse.redirect(new URL(redirectTarget, effectiveOrigin));
    const maxAge = Number.parseInt(String(tokenResponse.expires_in ?? 3600), 10) || 3600;
    const cookieOptions: Parameters<typeof res.cookies.set>[2] = {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      path: '/',
      maxAge,
    };

    const accessToken = tokenResponse.access_token ?? tokenResponse.id_token;
    if (!accessToken) {
      return NextResponse.json({ error: { code: 'NO_TOKEN', message: 'No id/access token returned' } }, { status: 500 });
    }
    res.cookies.set('sp_token', accessToken, cookieOptions);
    res.cookies.set('sp_at', tokenResponse.access_token ?? accessToken, cookieOptions);
    if (tokenResponse.id_token) {
      res.cookies.set('sp_it', tokenResponse.id_token, cookieOptions);
    }
    if (tokenResponse.refresh_token) {
      res.cookies.set('sp_rt', tokenResponse.refresh_token, {
        ...cookieOptions,
        maxAge: 30 * 24 * 60 * 60,
      });
    }

    // Optional debug cookie for token_use (non-HTTP to inspect quickly)
    try {
      const [, payloadB64] = accessToken.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      if (payload.token_use) {
        res.cookies.set('safepocket_token_use', String(payload.token_use), {
          path: '/',
          maxAge: 120,
          httpOnly: false,
          sameSite: 'lax',
          secure: secureCookie,
        });
      }
    } catch {
      // ignore malformed JWTs
    }

    res.headers.set('x-safepocket-cookie-secure', String(secureCookie));
    res.headers.set('x-safepocket-proto', proto);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Auth callback failed';
    return NextResponse.json({ error: { code: 'EXCHANGE_ERROR', message } }, { status: 500 });
  }
}

async function exchangeAuthorizationCode(params: {
  domain: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
}) {
  const { domain, clientId, clientSecret, code, redirectUri } = params;
  const url = buildCognitoUrl(domain, '/oauth2/token');
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', clientId);
  body.set('redirect_uri', redirectUri);
  body.set('code', code);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  const text = await response.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // ignore parse errors; payload stays {}
    }
  }

  if (!response.ok) {
    const errorDescription = payload?.error_description || payload?.error || `Token exchange failed (${response.status})`;
    throw new Error(errorDescription);
  }

  return payload;
}

function buildCognitoUrl(domain: string | null | undefined, path: string): string {
  if (!domain || !domain.trim()) {
    throw new Error('Missing Cognito domain');
  }
  const trimmed = domain.trim().replace(/\/+$/, '');
  const hasProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://');
  const base = hasProtocol ? trimmed : `https://${trimmed}`;
  return `${base}${path}`;
}

function safeRedirectPath(raw: string): string {
  if (!raw.startsWith('/')) return '/dashboard';
  // Avoid open redirects – restrict to dashboard area for now
  if (!raw.startsWith('/dashboard')) return '/dashboard';
  return raw;
}

function sanitizeEnv(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
