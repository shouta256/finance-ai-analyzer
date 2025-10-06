import { NextRequest } from 'next/server';

// Additional alias to support legacy /api/auth/callback/cognito redirect URIs.
// Redirects to unified /auth/callback preserving all query parameters (code, state, etc.).
export async function GET(req: NextRequest) {
  const redirect = new URL('/auth/callback', req.nextUrl.origin);
  req.nextUrl.searchParams.forEach((value, key) => redirect.searchParams.set(key, value));
  return Response.redirect(redirect.toString(), 302);
}
