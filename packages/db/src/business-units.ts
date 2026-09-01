import { jstNow } from './utils.js';

// =============================================================================
// Business Units — 予約が属する営業単位(店舗)
//
// 🔑 「予約がどの店に属するか(business_unit)」と「予約をどの外部サービスに流すか
//    (connector)」は別の軸。1つの店舗が SALON BOARD と BeautyMerit の2接続を持つ
//    構成が実在するため、bookings は business_unit に属し、同期先は
//    business_unit_connectors 経由で 0〜N 個になる。
// =============================================================================

export interface BusinessUnit {
  id: string;
  line_account_id: string;
  name: string;
  sort_order: number;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type BusinessUnitResolution =
  | { ok: true; businessUnitId: string }
  | { ok: false; reason: 'no_business_unit' | 'ambiguous_business_unit' };

/** テナントの既定 business_unit の ID。マイグレーション 050 のバックフィルと同じ導出。 */
export function defaultBusinessUnitId(lineAccountId: string): string {
  return `bu_${lineAccountId}`;
}

/**
 * 予約が属する business_unit を解決する。
 *
 * 🔴 fail-closed。決められない時は「それらしい1件」を選ばない。
 *    候補が0件 → no_business_unit / 2件以上 → ambiguous_business_unit を返し、
 *    呼び出し側は予約を作らずにエラーを返す。
 *
 * 📘 なぜ「最初の1件」を選ばないか：紐づけ漏れのまま別店舗の予約として登録されると、
 *    その店の枠が塞がり、本来の店の枠は開いたままになる(ダブルブッキングと
 *    架空の機会損失が同時に起きる)。しかも「値が入っている」ので NULL 監視をすり抜ける。
 *    NULL より、もっともらしい誤った値の方が危険。
 *
 * ⚠️ 将来スタッフ単位で所属店舗を持つ場合(staff.business_unit_id 等)は、
 *    ここで「スタッフの明示的な所属 → テナントに1件だけ → それ以外はエラー」の順にする。
 */
export async function resolveBusinessUnitId(
  db: D1Database,
  lineAccountId: string,
): Promise<BusinessUnitResolution> {
  const rows = await db
    .prepare(
      `SELECT id FROM business_units
        WHERE line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY sort_order, id
        LIMIT 2`,
    )
    .bind(lineAccountId)
    .all<{ id: string }>();
  const found = rows.results ?? [];
  if (found.length === 0) return { ok: false, reason: 'no_business_unit' };
  if (found.length > 1) return { ok: false, reason: 'ambiguous_business_unit' };
  return { ok: true, businessUnitId: found[0].id };
}

/**
 * テナント作成時に既定 business_unit を作る文を返す。
 * 🔑 呼び出し側は line_accounts の INSERT と同じ batch() に入れること。
 *    batch は1トランザクションなので、「テナントだけ存在して business_unit が無い」
 *    という中間状態そのものを作らない(＝正常操作で不変条件を壊せなくする)。
 */
export function defaultBusinessUnitStatement(
  db: D1Database,
  lineAccountId: string,
  name: string,
): D1PreparedStatement {
  const now = jstNow();
  return db
    .prepare(
      `INSERT INTO business_units (id, line_account_id, name, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, ?)`,
    )
    .bind(defaultBusinessUnitId(lineAccountId), lineAccountId, name, now, now);
}

export async function listBusinessUnits(
  db: D1Database,
  lineAccountId: string,
): Promise<BusinessUnit[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM business_units
        WHERE line_account_id = ? AND deleted_at IS NULL
        ORDER BY sort_order, id`,
    )
    .bind(lineAccountId)
    .all<BusinessUnit>();
  return rows.results ?? [];
}
