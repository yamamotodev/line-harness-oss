import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'
import { BRAND_NAME } from '@/lib/brand'

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: `${BRAND_NAME} 管理画面`,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
