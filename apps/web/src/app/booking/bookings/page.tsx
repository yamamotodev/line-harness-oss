'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { bookingApi, type BookingRequest } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'requested', label: '未承認' },
  { key: 'confirmed', label: '確定' },
  { key: 'rejected', label: '拒否' },
  { key: 'expired', label: '期限切れ' },
  { key: 'cancelled', label: 'キャンセル' },
  { key: 'sync', label: '同期ブロック' },
  { key: 'all', label: '全件' },
]

const statusBadgeColor: Record<string, string> = {
  requested: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-100 text-gray-700',
  expired: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
  no_show: 'bg-red-100 text-red-800',
}

const statusLabel: Record<string, string> = {
  requested: 'リクエスト',
  confirmed: '確定',
  rejected: '拒否',
  expired: '期限切れ',
  cancelled: 'キャンセル',
  completed: '完了',
  no_show: '無断',
}

const actionLabel: Record<string, string> = {
  approve: '承認',
  reject: '拒否',
  cancel: 'キャンセル',
  no_show: '無断キャンセル',
  complete: '完了',
}

function formatJpDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  })
}

export default function BookingsPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [tab, setTab] = useState<string>('requested')
  const [items, setItems] = useState<BookingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // copied 状態は URL 単位で持つ。アカウント切替で shareUrl が変わると
  // 自動で「コピー済」が消えるので、A の URL をコピーしたまま B 画面で
  // 「B フォームと思い込んで送信」する事故を防ぐ。
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  const liffId = selectedAccount?.liffId ?? null
  // Worker `/o` は ref 解決・追跡なしで liffId を直接受けるラップ URL。
  // `liff.line.me` を直貼りすると OpenChat / IG DM 等で削除されるため、
  // LINE 内配信も SNS 配信もこの 1 本で完結させる。/o は LINE 内 UA でも
  // 「LINEで開く」ボタン経由で Universal Link → LIFF を起動する。
  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const shareUrl = workerBase && liffId
    ? `${workerBase}/o?liffId=${encodeURIComponent(liffId)}&page=salon-book`
    : null
  const copied = copiedUrl !== null && copiedUrl === shareUrl

  async function copyUrl(url: string | null) {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      setTimeout(() => {
        setCopiedUrl((cur) => (cur === url ? null : cur))
      }, 2000)
    } catch {
      window.prompt('コピーしてください:', url)
    }
  }

  const load = useCallback(async () => {
    if (!selectedAccountId) return
    setLoading(true)
    setError(null)
    // タブ/アカウント切り替えで先に list をクリア。fetch 失敗時に前タブの行が
    // 残ってしまい、誤って別ステータスの予約を操作してしまう事故を防ぐ。
    setItems([])
    try {
      const r = await bookingApi.listRequests(selectedAccountId, tab)
      setItems(r.requests)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, tab])

  useEffect(() => {
    load()
  }, [load])

  async function handleDecide(id: string, action: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete') {
    if (!selectedAccountId) return
    if (!confirm(`この予約を「${actionLabel[action]}」しますか？`)) return
    try {
      await bookingApi.decideRequest(selectedAccountId, id, action)
      await load()
    } catch (e) {
      alert(`操作に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div>
      <Header
        title="予約管理"
        description="顧客からの予約リクエストを承認・拒否します"
      />

      {selectedAccountId && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-900 mb-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.828 10.172a4 4 0 015.656 0l1.414 1.414a4 4 0 010 5.656l-3 3a4 4 0 01-5.656 0L10 18.343M10.172 13.828a4 4 0 01-5.656 0L3.1 12.414a4 4 0 010-5.656l3-3a4 4 0 015.656 0L14 5.657"
              />
            </svg>
            お客様向け 予約フォーム LIFF URL
          </div>
          {shareUrl ? (
            <>
              <div className="flex gap-2 items-center">
                <input
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 border border-blue-200 rounded-lg px-3 py-2 text-xs bg-white font-mono"
                />
                <button
                  type="button"
                  onClick={() => copyUrl(shareUrl)}
                  className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {copied ? 'コピー済' : 'コピー'}
                </button>
              </div>
              <p className="text-xs text-blue-700 mt-2">
                LINE / OpenChat / IG DM どこでも貼れます。受信者がタップすると LINE で予約画面が開きます。
              </p>
            </>
          ) : (
            <p className="text-xs text-amber-700">
              このアカウントには LIFF ID が未設定です。
              <a href="/accounts" className="underline ml-1">アカウント設定</a> で LIFF ID を登録してください。
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              tab === key ? 'text-white' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
            }`}
            style={tab === key ? { backgroundColor: '#06C755' } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {!selectedAccountId ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
          サイドバーでアカウントを選択してください
        </div>
      ) : loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
          読み込み中…
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
          該当する予約はありません
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">日時</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">顧客</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">メニュー</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">担当</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">要望</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">料金</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">状態</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm whitespace-nowrap">{formatJpDateTime(b.starts_at)}</td>
                    <td className="px-4 py-3 text-sm">
                      <Link
                        href={`/chats?friend=${b.friend_id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {b.friend_name ?? '-'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">{b.menu_name}</td>
                    <td className="px-4 py-3 text-sm">{b.staff_name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={b.customer_note ?? ''}>
                      {b.customer_note ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">¥{b.price_at_booking.toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${statusBadgeColor[b.status] ?? 'bg-gray-100'}`}>
                        {statusLabel[b.status] ?? b.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ActionButtons status={b.status} onAction={(a) => handleDecide(b.id, a)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionButtons({
  status,
  onAction,
}: {
  status: string
  onAction: (a: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete') => void
}) {
  if (status === 'requested') {
    return (
      <div className="inline-flex gap-1">
        <button
          onClick={() => onAction('approve')}
          className="px-3 py-1 text-xs font-medium text-white rounded-md transition-opacity hover:opacity-90"
          style={{ backgroundColor: '#06C755' }}
        >
          承認
        </button>
        <button
          onClick={() => onAction('reject')}
          className="px-3 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md"
        >
          拒否
        </button>
      </div>
    )
  }
  if (status === 'confirmed') {
    return (
      <div className="inline-flex gap-1">
        <button
          onClick={() => onAction('complete')}
          className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md"
        >
          完了
        </button>
        <button
          onClick={() => onAction('no_show')}
          className="px-3 py-1 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-md"
        >
          無断
        </button>
        <button
          onClick={() => onAction('cancel')}
          className="px-3 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md"
        >
          取消
        </button>
      </div>
    )
  }
  return <span className="text-xs text-gray-400">-</span>
}
