/** @type {import('next').NextConfig} */

// The dashboard always talks to the engine through the relative `/api` prefix.
//  - standalone / VPS / local dev  -> Next rewrites /api/* to the engine port
//  - Emergent preview             -> the ingress routes /api/* to backend/server.py
//                                    which proxies to the very same engine port
const ENGINE_ORIGIN = process.env.ENGINE_ORIGIN || 'http://127.0.0.1:8790'

const nextConfig = {
  reactStrictMode: false,
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${ENGINE_ORIGIN}/api/:path*` }]
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ]
  },
}

export default nextConfig
