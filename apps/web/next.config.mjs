/** @type {import('next').NextConfig} */
const config = {
  experimental: {
    typedRoutes: true,
  },
  reactStrictMode: true,
  output: 'standalone',
  // No development rewrites; use canonical /api/* routes from the app
};

export default config;
