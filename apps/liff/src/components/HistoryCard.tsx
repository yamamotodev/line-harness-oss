import { useState } from 'react';
import type { BookingHistoryItem } from '../lib/api.js';
import { utcToJstDisplay } from '../lib/datetime.js';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  requested: { label: 'リクエスト中', color: 'bg-yellow-100 text-yellow-800' },
  confirmed: { label: '確定', color: 'bg-green-100 text-green-800' },
  rejected: { label: '不可', color: 'bg-gray-100 text-gray-600' },
  expired: { label: '期限切れ', color: 'bg-gray-100 text-gray-600' },
  cancelled: { label: 'キャンセル', color: 'bg-gray-100 text-gray-600' },
  completed: { label: '完了', color: 'bg-blue-100 text-blue-800' },
  no_show: { label: '無断キャンセル', color: 'bg-red-100 text-red-800' },
};

export default function HistoryCard({
  booking,
  onCancel,
  busy = false,
}: {
  booking: BookingHistoryItem;
  /** 押されたら親が API を叩いて一覧を再取得する。省略時はボタンを出さない。 */
  onCancel?: (booking: BookingHistoryItem) => void | Promise<void>;
  busy?: boolean;
}) {
  // 二段階にする理由: スマホの一覧で「キャンセル」を誤タップすると取り返しがつかない。
  // window.confirm はアプリ内ブラウザで見た目が崩れるので、その場で展開する。
  const [confirming, setConfirming] = useState(false);
  const meta = STATUS_LABEL[booking.status] ?? { label: booking.status, color: 'bg-gray-100' };
  const showCancel = Boolean(onCancel) && booking.can_cancel === true;

  return (
    <li className="border rounded overflow-hidden">
      <div className="p-3 flex gap-3 items-start">
        {booking.profile_image_url ? (
          <img
            src={booking.profile_image_url}
            alt={booking.staff_name}
            className="w-12 h-12 rounded-full object-cover"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gray-200" />
        )}
        <div className="flex-1">
          <div className="font-medium">{booking.menu_name}</div>
          <div className="text-sm text-gray-600">{booking.staff_name}</div>
          <div className="text-sm text-gray-600">{utcToJstDisplay(booking.starts_at)}</div>
        </div>
        <span className={`text-xs px-2 py-1 rounded h-fit ${meta.color}`}>{meta.label}</span>
      </div>

      {showCancel && !confirming && (
        <div className="border-t px-3 py-2 text-right">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-sm text-red-600 underline"
          >
            キャンセルする
          </button>
        </div>
      )}

      {showCancel && confirming && (
        <div className="border-t bg-gray-50 px-3 py-3 space-y-2">
          <p className="text-sm">この予約をキャンセルします。よろしいですか？</p>
          <p className="text-xs text-gray-500">
            日時を変える場合は、キャンセルしたあとにもう一度ご予約ください。
          </p>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="text-sm px-3 py-1.5 rounded border bg-white disabled:opacity-50"
            >
              やめる
            </button>
            {/* 連打すると2件飛ぶ。押した瞬間に無効化する。 */}
            <button
              type="button"
              onClick={() => onCancel?.(booking)}
              disabled={busy}
              className="text-sm px-3 py-1.5 rounded bg-red-600 text-white disabled:opacity-50"
            >
              {busy ? '処理中...' : 'キャンセルする'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
