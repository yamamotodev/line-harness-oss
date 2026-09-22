// Booking feature shared types & constants.
// IDs are TEXT (UUID/nanoid) to follow line-harness schema.sql conventions.

export type BookingStatus =
  | 'requested'
  | 'confirmed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'no_show';

export type ReminderKind = 'day_before' | 'hours_before';

export type ReminderStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'failed_permanent'
  | 'cancelled';

export interface MenuRow {
  id: string;
  line_account_id: string;
  name: string;
  category_label: string | null;
  description: string | null;
  duration_minutes: number;
  buffer_after_minutes: number;
  base_price: number;
  sort_order: number;
  is_active: number;
  deleted_at: string | null;
}

export interface StaffRow {
  id: string;
  line_account_id: string;
  name: string;
  display_name: string;
  role: string | null;
  profile_image_url: string | null;
  bio: string | null;
  sort_order: number;
  is_designation_optional: number;
  is_active: number;
  deleted_at: string | null;
}

export interface StaffMenuRow {
  staff_id: string;
  menu_id: string;
  is_offered: number;
  override_duration_minutes: number | null;
  override_price: number | null;
}

export interface ShiftRow {
  id: string;
  staff_id: string;
  work_date: string;  // YYYY-MM-DD JST
  start_time: string; // HH:MM JST
  end_time: string;   // HH:MM JST
}

export interface BookingRow {
  id: string;
  line_account_id: string;
  friend_id: string;
  staff_id: string;
  menu_id: string;
  starts_at: string;       // UTC ISO8601 (Z)
  ends_at: string;
  block_ends_at: string;
  status: BookingStatus;
  customer_note: string | null;
  internal_note: string | null;
  price_at_booking: number;
  requested_at: string;
  decided_at: string | null;
  decided_by_staff_id: string | null;
}

export interface AvailabilitySlot {
  date: string;  // YYYY-MM-DD JST
  start: string; // HH:MM JST
  end: string;   // HH:MM JST
}

export interface AvailabilityByStaff {
  staff_id: string;
  display_name: string;
  slots: AvailabilitySlot[];
}

/**
 * D1 を読まずに使える静的な既定値の型。
 *
 * 🔴 `booking_horizon_days`（何日先まで売るか）はここに無い。2026-09-23 に
 *    定数 14 を廃止し、D1 の account_settings から読むようにした
 *    (`./booking-horizon.ts` の `getBookingHorizonDays` / `resolveSalesHorizon`)。
 *
 *    廃止した理由: 14 は「LIFF の DateTimePicker が見せている範囲
 *    (RANGE_DAYS = 14)」に合わせただけの値で、販売上限の実測ではなかった。
 *    管理画面 (GET /api/booking/admin/availability) は1リクエスト28日の上限が
 *    あるだけで先の日付を何度でも引けるため、14 は実際の販売範囲より狭い。
 *    狭い上限を bootstrap の完了判定に使うと、同期は 365 日分やるのに
 *    完了判定は 14 日分で ready と言い、15〜365 日目が「同期できていないのに
 *    売られている」状態になる。(決定 = R20260923-0100)
 */
export interface AccountSettings {
  reminder_hours_before: number;
  min_lead_time_minutes: number;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  reminder_hours_before: 2,
  min_lead_time_minutes: 60,
};

export const SLOT_GRANULARITY_MINUTES = 30;
export const REQUEST_TTL_HOURS = 24;
export const IDEMPOTENCY_TTL_MINUTES = 5;
export const REMINDER_MAX_RETRY = 3;
