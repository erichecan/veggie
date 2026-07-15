import type { NextConfig } from "next";
import { withSentryConfig } from '@sentry/nextjs'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// Content Security Policy
// 注意：Sentry tunnelRoute + Next Image + GCS + Pexels
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://browser.sentry-cdn.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://storage.googleapis.com https://images.pexels.com https://commons.wikimedia.org https://upload.wikimedia.org",
  "font-src 'self' data:",
  "connect-src 'self' https://*.sentry.io wss://*.neon.tech https://*.neon.tech https://storage.googleapis.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
]

const nextConfig: NextConfig = {
  output: 'standalone',
  // 汇总单服务端 PDF（无头 Chromium）：puppeteer-core 内部有运行时按需 require，交给 Next
  // 走外部化处理而不是 webpack 打包，避免打包期分析失败或产物里少东西。
  serverExternalPackages: ['puppeteer-core'],
  // pdf-parse(采购单 PDF 识别用)内部用 Module.createRequire() 动态 require('@napi-rs/canvas')
  // 来 polyfill globalThis.DOMMatrix——这个 require 调用是运行时字符串拼出来的，不是字面量
  // require("...")，Next.js 的构建期文件追踪(@vercel/nft)识别不出来，standalone 产物里就
  // 不会带上这个原生模块，线上报 "Cannot load @napi-rs/canvas" + "DOMMatrix is not defined"
  // 500（2026-07-14 客户反馈）。显式声明追踪范围，把该模块连同其平台原生二进制一并打进
  // .next/standalone/node_modules。
  outputFileTracingIncludes: {
    '/api/purchase-orders/pdf-extract': ['./node_modules/@napi-rs/**/*'],
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false }
    }
    return config
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
      },
      {
        protocol: 'https',
        hostname: 'images.pexels.com',
      },
      {
        protocol: 'https',
        hostname: 'commons.wikimedia.org',
        pathname: '/w/index.php',
      },
      {
        protocol: 'https',
        hostname: 'upload.wikimedia.org',
        pathname: '/wikipedia/**',
      },
    ],
  },
};

export default withSentryConfig(withNextIntl(nextConfig), {
  silent: true,
  tunnelRoute: '/monitoring',
  sourcemaps: { disable: true },
  telemetry: false,
  unstable_sentryWebpackPluginOptions: {
    applicationKey: 'veggie-demo',
  },
});
