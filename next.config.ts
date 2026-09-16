import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint is a separate, explicit gate (`pnpm lint`) so a lint failure
    // never silently masquerades as a build failure.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
