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

export interface AccountSettings {
  reminder_hours_before: number;
  min_lead_time_minutes: number;
  /**
   * 何日先まで予約を受け付けるか（販売上限）。
   *
   * 🔑 14 なのは、LIFF の DateTimePicker が実際に見せている範囲(RANGE_DAYS = 14)と
   *    一致させたから。ここを実物より広く書くと、「売っているのに同期していない
   *    日付」が生まれる(＝bootstrap の完了判定が甘くなる)。
   *
   * 使う側:
   *   - bootstrap の完了判定 … coverage_through >= 販売上限 を満たして初めて
   *     scope を ready にする(migration 051 / 指示書 §5-3)。
   *     販売上限 = min(staff_shifts の最終日, booking_horizon_days)
   *   - gate は「要求された日付が coverage_through 以内か」を日付単位で見るので、
   *     この定数には依存しない。
   */
  booking_horizon_days: number;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  reminder_hours_before: 2,
  min_lead_time_minutes: 60,
  booking_horizon_days: 14,
};

export const SLOT_GRANULARITY_MINUTES = 30;
export const REQUEST_TTL_HOURS = 24;
export const IDEMPOTENCY_TTL_MINUTES = 5;
export const REMINDER_MAX_RETRY = 3;
