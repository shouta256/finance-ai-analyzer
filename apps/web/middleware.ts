import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  matcher: [
    '/((?!_next/|favicon\\.(?:ico|png)$|robots\\.txt|sitemap\\.xml|.*\\.(?:js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|otf|map)$|api/healthz|api/actuator/health/liveness).*)',
  ],
};

export default function middleware(_req: NextRequest) {
  return NextResponse.next();
}
