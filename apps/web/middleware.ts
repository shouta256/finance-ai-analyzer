import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|robots\\.txt|sitemap\\.xml|api/healthz|api/actuator/health/liveness).*)',
  ],
};

export default function middleware(_req: NextRequest) {
  return NextResponse.next();
}
