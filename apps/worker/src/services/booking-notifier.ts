import { LineClient } from '@line-crm/line-sdk';

export type NotificationKind =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'day_before'
  | 'hours_before'
  // お客様が LIFF の予約履歴から自分でキャンセルした
  | 'cancelled_by_friend'
  // お店（管理画面）が予約を取り消した
  | 'cancelled_by_shop';

export interface NotificationContext {
  menuName: string;
  staffName: string;
  startsAtJst: string; // 例: "2026-05-10 14:00"
  hoursBefore: number;
}

export function renderNotificationText(
  kind: NotificationKind,
  ctx: NotificationContext,
): string {
  const detail = `\nメニュー: ${ctx.menuName}\n担当: ${ctx.staffName}\n日時: ${ctx.startsAtJst}`;
  switch (kind) {
    case 'requested':
      return `予約リクエストを受け付けました。${detail}\n\nお店からの返信をお待ちください。`;
    // 「お店に連絡してください」から「自分で操作できます」へ。予約履歴に
    // キャンセルボタンが出るようになったので、電話の一手間を無くす。
    case 'approved':
      return `予約が確定しました。${detail}\n\n日時の変更・キャンセルは「予約確認」からお願いします。日時を変える場合は、一度キャンセルしてから取り直してください。`;
    case 'rejected':
      return `申し訳ありません、ご希望の枠でお取りできませんでした。\n別の日時で再度お試しください。`;
    case 'expired':
      return `予約リクエストが 24 時間返信が無かったため、期限切れになりました。${detail}`;
    case 'day_before':
      return `明日のご予約のお知らせです。${detail}`;
    case 'hours_before':
      return `本日のご予約まであと ${ctx.hoursBefore} 時間です。${detail}`;
    // 本人の操作だが、LINE に記録が残らないと「本当に取り消せた？」の問い合わせになる。
    case 'cancelled_by_friend':
      return `ご予約をキャンセルしました。${detail}\n\nまたのご利用をお待ちしております。`;
    case 'cancelled_by_shop':
      return `申し訳ありません、こちらのご予約をキャンセルさせていただきました。${detail}\n\nご不明な点はお気軽にご連絡ください。`;
  }
}

export interface SendNotificationParams {
  channelAccessToken: string;
  toLineUserId: string;
  kind: NotificationKind;
  ctx: NotificationContext;
}

export async function sendBookingNotification(params: SendNotificationParams): Promise<void> {
  const text = renderNotificationText(params.kind, params.ctx);
  const client = new LineClient(params.channelAccessToken);
  await client.pushMessage(params.toLineUserId, [{ type: 'text', text }]);
}

export type BookingNotificationSender = (params: SendNotificationParams) => Promise<void>;
