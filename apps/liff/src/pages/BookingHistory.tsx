import { useCallback, useEffect, useState } from 'react';
import { api, type BookingHistoryItem } from '../lib/api.js';
import HistoryCard from '../components/HistoryCard.js';

// Worker が返すエラーコードを、お客様に読める日本語にする。
// ここを素の英語コードのまま出すと問い合わせが増える。
function cancelErrorMessage(err: unknown): string {
  const code = (err as { body?: { error?: string } })?.body?.error;
  switch (code) {
    case 'cancel_deadline_passed':
      return 'キャンセルできる期限を過ぎています。お手数ですがお店にご連絡ください。';
    case 'cancel_not_allowed':
      return 'ご自身でのキャンセルは受け付けていません。お店にご連絡ください。';
    case 'invalid_state':
      return 'この予約はすでにキャンセル済み、または対象外です。';
    case 'concurrent_update':
      return 'お店側で状態が変わったため、キャンセルできませんでした。最新の状態をご確認ください。';
    case 'unauthorized':
      return 'ログイン情報を確認できませんでした。LINE から開き直してください。';
    default:
      return 'キャンセルできませんでした。時間をおいてもう一度お試しください。';
  }
}

export default function BookingHistory() {
  const [data, setData] = useState<{ upcoming: BookingHistoryItem[]; past: BookingHistoryItem[] } | null>(
    null,
  );
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.me();
    setData(res);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCancel = useCallback(
    async (booking: BookingHistoryItem) => {
      // 連打対策その2（UI の disabled が効かない経路で二重送信させない）
      if (busyId) return;
      setBusyId(booking.id);
      setError(null);
      setNotice(null);
      try {
        await api.cancelMyBooking(booking.id);
        setNotice('予約をキャンセルしました。');
        await refresh();
      } catch (err) {
        setError(cancelErrorMessage(err));
        // 失敗の理由が「もう状態が変わっていた」ことも多いので一覧を取り直す
        await refresh().catch(() => undefined);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  if (!data) return <div className="p-4 text-gray-500">読み込み中...</div>;
  const list = tab === 'upcoming' ? data.upcoming : data.past;

  return (
    <div className="max-w-md mx-auto p-4 space-y-4">
      <div className="flex border-b">
        <button
          onClick={() => setTab('upcoming')}
          className={`flex-1 py-2 ${tab === 'upcoming' ? 'border-b-2 border-blue-600 font-semibold' : ''}`}
        >
          これから ({data.upcoming.length})
        </button>
        <button
          onClick={() => setTab('past')}
          className={`flex-1 py-2 ${tab === 'past' ? 'border-b-2 border-blue-600 font-semibold' : ''}`}
        >
          過去 ({data.past.length})
        </button>
      </div>

      {notice && (
        <div className="bg-green-50 text-green-800 text-sm rounded p-2">{notice}</div>
      )}
      {error && <div className="bg-red-50 text-red-700 text-sm rounded p-2">{error}</div>}

      {list.length === 0 ? (
        <p className="text-gray-500 text-center pt-8">まだ予約がありません。</p>
      ) : (
        <ul className="space-y-2">
          {list.map((b) => (
            <HistoryCard
              key={b.id}
              booking={b}
              onCancel={tab === 'upcoming' ? handleCancel : undefined}
              busy={busyId === b.id}
            />
          ))}
        </ul>
      )}

      <p className="text-xs text-gray-500 pt-4">
        日時を変更したい場合は、キャンセルしてからもう一度ご予約ください。
        キャンセルの期限を過ぎている場合は、お店に LINE でご連絡ください。
      </p>
    </div>
  );
}
