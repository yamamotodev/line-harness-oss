// サロン予約（bookings）の「お客様self キャンセル」の判定ロジック。
//
// ルート（booking.ts）から切り出してある理由は2つ:
//   1. LIFF の POST .../cancel と GET /api/liff/booking/me の can_cancel 計算で
//      同じ規則を使うため。片方だけ直すと「ボタンは出るが押すと 409」が起きる。
//   2. D1 を持ち込まずに単体テストできるようにするため。
//
// 期限の置き場は account_settings（key-value）。専用カラムを足していないので
// マイグレーション不要＝本番 D1 にスキーマ変更を流さずに設定を増やせる。
// 既存の booking_horizon_days / hpb_sync_enabled と同じ形。

export const CANCEL_DEADLINE_SETTING_KEY = 'cancel_deadline_hours_before';

/** 未設定のアカウントに適用される既定値（時間）。 */
export const DEFAULT_CANCEL_DEADLINE_HOURS = 24;

/** account_settings.value に入れると「self キャンセル禁止」になる値。 */
export const CANCEL_DISABLED_VALUE = 'off';

/**
 * account_settings の生の文字列を時間数に解釈する。
 *
 *   "24"        -> 24    （開始 24 時間前まで）
 *   "0"         -> 0     （開始時刻まで）
 *   "off" / ""  -> null  （self キャンセル禁止＝店に連絡してもらう）
 *   未設定(null) -> 既定値
 *   壊れた値     -> 既定値（安全側。キャンセルできない方が HPB に幽霊予約が残るため）
 */
export function parseCancelDeadlineHours(raw: string | null | undefined): number | null {
  if (raw == null) return DEFAULT_CANCEL_DEADLINE_HOURS;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === CANCEL_DISABLED_VALUE || v === 'null' || v === 'false') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[booking-cancel] 不正な ${CANCEL_DEADLINE_SETTING_KEY}=${JSON.stringify(raw)} → 既定 ${DEFAULT_CANCEL_DEADLINE_HOURS}h を使用`,
    );
    return DEFAULT_CANCEL_DEADLINE_HOURS;
  }
  return n;
}

/** アカウントのキャンセル期限（時間）。null は self キャンセル禁止。 */
export async function getCancelDeadlineHours(
  db: D1Database,
  accountId: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(accountId, CANCEL_DEADLINE_SETTING_KEY)
    .first<{ value: string }>();
  return parseCancelDeadlineHours(row?.value ?? null);
}

export type CancelBlockReason = 'cancel_not_allowed' | 'cancel_deadline_passed';

export interface CancelCheckArgs {
  /** 予約の開始時刻（UTC ISO8601）。 */
  startsAt: string;
  /** getCancelDeadlineHours の戻り値。 */
  deadlineHours: number | null;
  now: Date;
}

/**
 * いま self キャンセルできるか。できない場合は理由を返す。
 * 呼び出し側で HTTP ステータスに割り当てる（not_allowed=403 / deadline_passed=409）。
 */
export function checkCancelWindow(
  args: CancelCheckArgs,
): { ok: true } | { ok: false; reason: CancelBlockReason } {
  if (args.deadlineHours == null) return { ok: false, reason: 'cancel_not_allowed' };
  const deadlineMs = new Date(args.startsAt).getTime() - args.deadlineHours * 3600_000;
  if (!Number.isFinite(deadlineMs)) return { ok: false, reason: 'cancel_not_allowed' };
  if (deadlineMs <= args.now.getTime()) return { ok: false, reason: 'cancel_deadline_passed' };
  return { ok: true };
}

/** 一覧表示用の真偽値。ボタンを出すかどうかをサーバー側で決める。 */
export function canCancelBooking(args: CancelCheckArgs & { status: string }): boolean {
  if (args.status !== 'requested' && args.status !== 'confirmed') return false;
  return checkCancelWindow(args).ok;
}

/**
 * その予約に紐づく未送信リマインダーを止める。
 * キャンセルしたのに前日リマインドが飛ぶ事故を防ぐ。
 */
export async function cancelPendingBookingReminders(
  db: D1Database,
  bookingId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE booking_reminders SET status='cancelled' WHERE booking_id = ? AND status = 'pending'`,
    )
    .bind(bookingId)
    .run();
}
