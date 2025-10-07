/** @type {import('next').NextConfig} */
const config = {
  experimental: {
    typedRoutes: true,
  },
  reactStrictMode: true,
  output: 'standalone',
  /**
   * Mitigation: some client-side request (still unidentified) is calling
   * /dashboard/api/analytics/summary (relative to the dashboard route)
   * which produces a 404. While we investigate root cause, rewrite any
   * accidental /dashboard/api/* path back to the canonical /api/* route
   * so the dashboard functions for users.
   * TODO(shouta): Remove this after confirming no relative fetch remains.
   */
  async rewrites() {
    return [
      { source: '/dashboard/api/:path*', destination: '/api/:path*' },
    ];
  },
};

export default config;
