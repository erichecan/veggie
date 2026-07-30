import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: "蔬菜批发管理系统",
  description: "从商品上架到签收回款的完整供应链管理平台",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    title: "蔬菜订购",
    statusBarStyle: "default",
  },
}

/**
 * Viewport 配置
 * ============================================================================
 * 司机、拣货、分货、餐馆老板都在手机上操作。必须：
 *   - width=device-width：不要缩放到桌面尺寸
 *   - initialScale=1：首屏不缩放
 *   - maximumScale=1：防止 iOS 双击放大打断流程（在有 input 时）
 *     注意：设为 1 会禁用用户放大，影响可访问性。Safari iOS 16+ 允许 "user-scalable": 'yes' 解决。
 *   - viewportFit=cover：刘海屏等异形区域铺满
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#875A7B',  // Odoo 紫，与主色一致
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-gray-50">
        {children}
        <Toaster richColors position="top-center" offset={72} />
      </body>
    </html>
  )
}
