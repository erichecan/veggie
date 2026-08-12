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
  // ⛔ HSTS 先短后长，别一上来就写两年。
  // HSTS 与普通证书告警不同：它没有「仍要继续」按钮。一旦浏览器记住了
  // max-age=63072000，证书出任何问题（签发失败、续期漏了、配置写错）用户就是
  // 打不开、也点不掉，而且这个记忆在**用户的浏览器里**，服务端改配置救不回来。
  // 2026-08-07 上 HTTPS 时从 300 秒起步，观察证书与自动续期稳定几天后，
  // 再显式提交把它升到 63072000（届时把这段注释一并更新）。
  // `preload` 也去掉了：那是"申请进浏览器内置名单"的信号，进去之后想退出要走
  // 官方移除流程并等浏览器发版，而我们才刚开始用这个域名。
  { key: 'Strict-Transport-Security', value: 'max-age=300' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
]

const nextConfig: NextConfig = {
  output: 'standalone',
  // 汇总单服务端 PDF（无头 Chromium）：puppeteer-core 内部有运行时按需 require，交给 Next
  // 走外部化处理而不是 webpack 打包，避免打包期分析失败或产物里少东西。
  // pdf-parse 同样必须外部化：被 webpack 打进 chunk 后，它 import 的 './pdf.worker.mjs'
  // 会指向 .next/server/chunks/ 下一个**根本不存在**的文件，standalone 产物一跑就
  // 「Setting up fake worker failed: Cannot find module …/chunks/pdf.worker.mjs」500。
  // dev 模式不打包所以看不出来 —— 台账 F2 在 standalone 上实测撞到的。
  serverExternalPackages: ['puppeteer-core', 'pdf-parse'],
  // pdf-parse(采购单 PDF 识别用)内部用 Module.createRequire() 动态 require('@napi-rs/canvas')
  // 来 polyfill globalThis.DOMMatrix——这个 require 调用是运行时字符串拼出来的，不是字面量
  // require("...")，Next.js 的构建期文件追踪(@vercel/nft)识别不出来，standalone 产物里就
  // 不会带上这个原生模块，线上报 "Cannot load @napi-rs/canvas" + "DOMMatrix is not defined"
  // 500（2026-07-14 客户反馈）。显式声明追踪范围，把该模块连同其平台原生二进制一并打进
  // .next/standalone/node_modules。
  outputFileTracingIncludes: {
    '/api/purchase-orders/pdf-extract': [
      './node_modules/@napi-rs/**/*',
      // pdfjs 的 worker 是运行时按路径动态 import 的，追踪器只带上了 pdf.mjs，
      // 漏了紧挨着它的 pdf.worker.mjs → standalone 上一解析 PDF 就
      // 「Setting up fake worker failed: Cannot find module …/pdf.worker.mjs」500。
      // 与上面 @napi-rs 是同一个病根（动态引用追踪不到），dev 模式看不出来。
      './node_modules/pdfjs-dist/legacy/build/*.mjs',
    ],
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
