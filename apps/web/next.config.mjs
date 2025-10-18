/** @type {import('next').NextConfig} */
const config = {
  experimental: {
    typedRoutes: true,
  },
  reactStrictMode: true,
  output: 'standalone',
  webpack: (cfg, { nextRuntime }) => {
    if (nextRuntime === 'edge') {
      cfg.resolve.fallback = {
        ...(cfg.resolve.fallback ?? {}),
        fs: false,
        path: false,
        os: false,
        crypto: false,
      };
    }
    return cfg;
  },
  // No development rewrites; use canonical /api/* routes from the app
};

export default config;
