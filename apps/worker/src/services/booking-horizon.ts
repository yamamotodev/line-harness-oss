// 販売上限（何日先まで予約を売れるか）を D1 から決める。
//
//   販売上限 = min(staff_shifts の最終日, 今日 + booking_horizon_days)
//
//   - シフト最終日 … 「何ヶ月先まで売るか」という営業判断。こちらが主。
//   - booking_horizon_days … 同期が暴走しないための安全弁(キャップ)。
//     シフトを何年先まで入れるかは導入先が決めるので、上限が無いと
//     ジョブBが何時間も外部を叩き続ける(2026-09-23 決定 / R20260923-0100)。
//
// 🔴 日数をコードに持たない。D1 の account_settings(key='booking_horizon_days')
//    を読む。この下の BOOKING_HORIZON_FALLBACK_DAYS は「D1 に行が無かった時」
//    だけの保険で、poc2 の line_hpb_mirror.mjs resolveHorizon() と同じ規則
//    (有限かつ 0 より大きい数値なら採用／でなければフォールバック)で動く。
//
// 🔴 ここを定数のままにして bootstrap の完了判定を書くと事故る。
//    同期は 365 日分やるのに完了判定は 14 日分で ready と言い、
//    15〜365 日目が「同期できていないのに売られている」状態になる。

import type { AccountSettings } from './booking-types.js';

/**
 * account_settings に行が無い時だけ使う既定値。
 *
 * 🔴 90 ではなく 365。90 だと「シフトは 365 日先まで入っているのに
 *    販売上限は 90 日」となり、91〜365 日目が未同期のまま売られる。
 *    上限は広く書く方が安全側（bootstrap の完了条件が厳しくなるだけ）。
 */
export const BOOKING_HORIZON_FALLBACK_DAYS = 365;

/** account_settings の key 名（poc2 と共有している文字列）。 */
export const BOOKING_HORIZON_SETTING_KEY = 'booking_horizon_days';

const JST_OFFSET_MS = 9 * 60 * 60_000;

function jstDateStr(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 生の設定値をキャップ日数に変換する。
 *
 * poc2 の `Number(capRaw)` と同じ規則。ただし2点だけ寛容にしてある:
 *   - JSON でくるまれた `"365"` も受ける。この repo の
 *     `setAccountSetting()` は値を JSON.stringify して書くので、
 *     管理画面から保存されると素の `365` にならない。
 *   - 小数は切り捨てる（日数の端数に意味が無いため）。
 */
export function parseHorizonDays(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return BOOKING_HORIZON_FALLBACK_DAYS;

  let n = Number(raw);
  if (!Number.isFinite(n)) {
    try {
      n = Number(JSON.parse(raw));
    } catch {
      return BOOKING_HORIZON_FALLBACK_DAYS;
    }
  }
  if (!Number.isFinite(n) || n <= 0) return BOOKING_HORIZON_FALLBACK_DAYS;
  return Math.floor(n);
}

/**
 * D1 の account_settings から booking_horizon_days を読む。
 * 行が無い／読めない値なら BOOKING_HORIZON_FALLBACK_DAYS。
 */
export async function getBookingHorizonDays(
  db: D1Database,
  lineAccountId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(lineAccountId, BOOKING_HORIZON_SETTING_KEY)
    .first<{ value: string }>();
  return parseHorizonDays(row?.value ?? null);
}

export interface SalesHorizon {
  /**
   * 販売上限。売れる最も先の日付 (YYYY-MM-DD JST)。
   * 🔑 シフトが1件も無ければ null＝そもそも1枠も売れないので上限も無い。
   */
  horizonDate: string | null;
  /** 予約可能なスタッフのシフト最終日 (YYYY-MM-DD JST)。無ければ null */
  lastShiftDate: string | null;
  /** D1 から決まったキャップ日数 */
  capDays: number;
  /** 今日 + capDays (YYYY-MM-DD JST) */
  capDate: string;
  /** どちらが上限を決めたか。horizonDate が null の時は null */
  limitedBy: 'shift' | 'cap' | null;
}

export interface ResolveSalesHorizonParams {
  lineAccountId: string;
  /** 「今日」を決める基準時刻。テストから固定できるように引数で受ける */
  now: Date;
}

/**
 * 販売上限 = min(シフト最終日, 今日 + キャップ) を返す。
 *
 * 🔴 シフト最終日は「予約できるスタッフ」だけで見る（is_active=1 かつ
 *    deleted_at IS NULL）。空き計算 getAvailability() が同じ条件で絞って
 *    いるので、そこに出てこないスタッフのシフトは売り物にならない。
 *    ここを絞らないと、売れない日付まで販売上限に数えて bootstrap の
 *    完了条件が無意味に厳しくなる。
 */
export async function resolveSalesHorizon(
  db: D1Database,
  params: ResolveSalesHorizonParams,
): Promise<SalesHorizon> {
  const capDays = await getBookingHorizonDays(db, params.lineAccountId);
  const today = jstDateStr(params.now.getTime());
  const capDate = addDays(today, capDays);

  const row = await db
    .prepare(
      `SELECT MAX(sh.work_date) AS last_shift_date
         FROM staff_shifts sh
         INNER JOIN staff s ON s.id = sh.staff_id
        WHERE s.line_account_id = ?
          AND s.is_active = 1
          AND s.deleted_at IS NULL`,
    )
    .bind(params.lineAccountId)
    .first<{ last_shift_date: string | null }>();
  const lastShiftDate = row?.last_shift_date ?? null;

  if (!lastShiftDate) {
    return { horizonDate: null, lastShiftDate: null, capDays, capDate, limitedBy: null };
  }

  // 文字列比較で足りる（どちらも YYYY-MM-DD 固定長・ゼロ埋め）。
  // 同着はシフト側を採る（poc2 の resolveHorizon と同じ）。
  const limitedBy = lastShiftDate <= capDate ? 'shift' : 'cap';
  return {
    horizonDate: limitedBy === 'shift' ? lastShiftDate : capDate,
    lastShiftDate,
    capDays,
    capDate,
    limitedBy,
  };
}

/**
 * booking_horizon_days を含めた実効的な設定値。
 * `DEFAULT_ACCOUNT_SETTINGS` は D1 を読めない場所用の静的な既定値なので、
 * 日数が要る呼び出し側はこちらを使う。
 */
export async function getEffectiveAccountSettings(
  db: D1Database,
  lineAccountId: string,
  defaults: AccountSettings,
): Promise<AccountSettings & { booking_horizon_days: number }> {
  return {
    ...defaults,
    booking_horizon_days: await getBookingHorizonDays(db, lineAccountId),
  };
}
