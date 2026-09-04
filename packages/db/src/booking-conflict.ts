// =============================================================================
// 二重予約防止の衝突判定
//
// 🔴 予約の作成は「競合チェック → INSERT」の2ステップにしない。
//    INSERT ... SELECT ... WHERE NOT EXISTS で1文にして原子化する。
//    2ステップだと、チェックと INSERT の間に別のリクエストが割り込める。
//    0行 INSERT (changes === 0) を 409 として扱う。
//
// 🔴 SQL をここに置いた理由＝worker のテストは D1 を「SQL断片マッチのモック」で
//    再現するので、この SQL が本当に衝突を弾くかを1つも検証できない。
//    ここに置けば packages/db のテストが本物の SQLite で実際に弾かれることを
//    確かめられる。ルートとテストが同じ文字列を使うので、SQL の写し間違いも起きない。
// =============================================================================

/**
 * 「この枠は空いている」を表す NOT EXISTS 述語。
 *
 * 空き条件は「staff が空き かつ resource も空き」の AND。
 * つまり衝突は「staff がぶつかる **または** resource がぶつかる」。
 *
 * 🔑 resourceId が NULL の時(＝美容室。設備を使わないメニュー)は
 *    `? IS NOT NULL` が偽になり、実質 `staff_id = ?` だけになる。
 *    設備を入れる前と完全に同じ判定。
 *
 * プレースホルダの順は bookingConflictParams() が返す配列と対応する。
 */
export const BOOKING_CONFLICT_NOT_EXISTS = `NOT EXISTS (
          SELECT 1 FROM bookings
           WHERE status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
             AND (staff_id = ? OR (? IS NOT NULL AND resource_id = ?))
        )`;

export interface BookingConflictParams {
  /** 作ろうとしている予約の block_ends_at (UTC ISO) */
  blockEndsAt: string;
  /** 作ろうとしている予約の starts_at (UTC ISO) */
  startsAt: string;
  staffId: string;
  /** 設備を使わないメニューでは null。 */
  resourceId?: string | null;
}

/** BOOKING_CONFLICT_NOT_EXISTS に bind する値。順番を間違えないようにここで作る。 */
export function bookingConflictParams(p: BookingConflictParams): (string | null)[] {
  const resourceId = p.resourceId ?? null;
  return [p.blockEndsAt, p.startsAt, p.staffId, resourceId, resourceId];
}
