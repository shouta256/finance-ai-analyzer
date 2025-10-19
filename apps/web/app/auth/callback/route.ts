import { NextRequest, NextResponse } from 'next/server';
import { ledgerFetch } from '@/src/lib/api-client';

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
    // Delegate token exchange to ledger service (ensures identical configuration across environments)
    const exchangeBody = {
      grantType: 'authorization_code' as const,
      code,
      redirectUri,
    };

    const exchange = await ledgerFetch<{
      accessToken: string;
      idToken?: string | null;
      refreshToken?: string | null;
      expiresIn: number;
      tokenType: string;
      scope?: string | null;
    }>("/auth/token", {
      method: "POST",
      body: JSON.stringify(exchangeBody),
      headers: { "content-type": "application/json" },
    });

    const token = exchange.accessToken || exchange.idToken;
    if (!token) {
      return NextResponse.json({ error: { code: 'NO_TOKEN', message: 'No id/access token returned' } }, { status: 500 });
    }

    const redirectTarget = safeRedirectPath(state);

    // Detect protocol to decide secure flag. NODE_ENV alone fails when HTTPS ends at the ALB but the app serves HTTP.
    const forwardedProto = req.headers.get('x-forwarded-proto');
    const proto = forwardedProto || (req.nextUrl.protocol.replace(':', '')) || 'https';
    const secureCookie = proto === 'https';

    // Use effectiveOrigin (x-forwarded-host if present) to avoid redirecting to 0.0.0.0:3000
    const res = NextResponse.redirect(new URL(redirectTarget, effectiveOrigin));
    // Cookie scopes entire app domain – use canonical sp_token (middleware expects this)
    res.cookies.set('sp_token', token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600, // 1h (Cognito token default 1h)
    });
    if (exchange.refreshToken) {
      res.cookies.set('sp_refresh', exchange.refreshToken, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60, // 30 days typical
      });
    }
    // Optional: set legacy cookie for temporary diagnostics (middleware ignores this)
    // res.cookies.set('safepocket_token', token, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/', maxAge: 3600 });
    // Removed previous JSON debug cookie (safepocket_token_flags) because browsers reject complex/JSON cookie values.
    // If needed, surface debug info via a temporary header (not cached) for manual inspection.
    res.headers.set('x-safepocket-cookie-secure', String(secureCookie));
    res.headers.set('x-safepocket-proto', proto);
    // Optional debug: expose token_use for quick validation (non-HTTP only; removed on refresh)
    try {
      const [, payloadB64] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      if (payload.token_use) {
        res.cookies.set('safepocket_token_use', String(payload.token_use), { path: '/', maxAge: 120, httpOnly: false });
      }
    } catch {
      // ignore
    }
    return res;
  } catch (e) {
    return NextResponse.json({ error: { code: 'EXCHANGE_ERROR', message: (e as Error).message } }, { status: 500 });
  }
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
