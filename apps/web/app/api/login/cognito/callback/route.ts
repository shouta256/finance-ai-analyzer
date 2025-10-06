import { NextRequest } from 'next/server';

// Alias callback route to maintain backward compatibility with older redirect_uri values.
// Redirects to /auth/callback preserving query parameters (code, state, etc.).
export async function GET(req: NextRequest) {
  const redirect = new URL('/auth/callback', req.nextUrl.origin);
  req.nextUrl.searchParams.forEach((value, key) => redirect.searchParams.set(key, value));
  return Response.redirect(redirect.toString(), 302);
}
