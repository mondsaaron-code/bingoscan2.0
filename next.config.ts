import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.ebayimg.com' },
      { protocol: 'https', hostname: 'i.ebayimg.com' },
      { protocol: 'https', hostname: 'www.sportscardspro.com' },
      { protocol: 'https', hostname: '**.sportscardspro.com' },
    ],
  },
};

export default nextConfig;
