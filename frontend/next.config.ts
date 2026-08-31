import type { NextConfig } from "next";

// In Docker Compose the backend is not published to the host; the Next server
// proxies API calls to it over the compose network. Unset in local dev, where
// the browser talks to localhost:8000 directly via NEXT_PUBLIC_API_URL.
const apiProxyTarget = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  async rewrites() {
    if (!apiProxyTarget) return [];
    return [
      { source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` },
      { source: "/health", destination: `${apiProxyTarget}/health` },
    ];
  },
};

export default nextConfig;
