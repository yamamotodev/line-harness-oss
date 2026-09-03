import { resolveBusinessUnitId } from './business-units.js';

// =============================================================================
// 予約可否の関門(gate)
//
// 🔴 関門は1つだけ作る。LIFFの空き表示 / LIFFの予約確定 / 管理画面の空き表示 /
//    管理画面の予約確定 の4箇所が、全部この関数を通る。
//    条件をアプリ各所に書くと必ずどこかで書き漏れる。表示側を閉じないと、人が
//    画面を見て手で予約を入れてしまうので、確定側だけでは足りない。
//
// 🔴 ここに置いた理由＝この判定はSQLがほぼ全てで、D1のモックでは正しさを検証
//    できない。packages/db に置けば better-sqlite3 に bootstrap.sql を流した
//    本物のDBでテストできる(VIEW・複合外部キー・COALESCE の一意キーまで実際に効く)。
//    resolveBusinessUnitId が business-units.ts にあるのと同じ形。
//
// 🔴 同期ジョブ(poc2/line_hpb_mirror.mjs)はこの関門を通らないし、通してはいけない。
//    同期ジョブは「外部の埋まりをHARK側にブロックとして書く」側なので、ここで
//    塞ぐと同期ブロックを作れなくなり、二度と ready にならない(デッドロック)。
//    同期ジョブ側は bookings.connector_id を必ず入れることで守る。
// =============================================================================

export type GateReason =
  /** 予約が属する営業単位が決まらない(0件 or 2件以上) */
  | 'no_business_unit'
  /** 有効な接続はあるが、この staff/resource を覆う scope が1つも無い */
  | 'no_scope'
  /** scope はあるが readiness が 'ready' でない(bootstrap 未完 / 失敗中) */
  | 'not_ready'
  /** fresh_until を過ぎている(dead-man switch が閉じた) */
  | 'stale'
  /** その日付まで同期が届いていない */
  | 'coverage_short'
  /** 媒体が空きを読めない、または予約を書けないのに読み取り専用の承諾が無い */
  | 'no_capability';

export interface Reservable {
  reservable: true;
  businessUnitId: string;
  /**
   * どの日付まで同期できているか(接続をまたいだ最小値)。
   * null = 有効な接続が1つも無い(＝外部在庫が存在しない)ので上限なし。
   * 空き表示側はこの日付より後のスロットを出してはいけない。
   */
  coverageThrough: string | null;
}

export interface NotReservable {
  reservable: false;
  reason: GateReason;
  businessUnitId: string | null;
  /** coverage_short の時、ここから先が未同期(YYYY-MM-DD)。それ以外は null。 */
  blockedFrom: string | null;
  /** 自動同期が最後に「成功した」時刻。「実行した」ではない。 */
  lastSuccessfulSyncAt: string | null;
  /** 手動実行の時刻。自動と混ぜて表示しない。 */
  lastManualRunAt: string | null;
}

export type Reservability = Reservable | NotReservable;

export interface ReservabilityParams {
  lineAccountId: string;
  /** 判定したい日付(YYYY-MM-DD JST)。範囲を見る時は先頭の日を渡す。 */
  date: string;
  staffId?: string | null;
  resourceId?: string | null;
  /** 解決済みなら渡す。渡さなければ fail-closed で解決する。 */
  businessUnitId?: string | null;
}

interface ConnectorRow {
  id: string;
  provider: string;
  readonly_ack: number;
}

interface ScopeRow {
  id: string;
  readiness: string;
  coverage_through: string | null;
  last_successful_sync_at: string | null;
  last_manual_run_at: string | null;
}

function blocked(
  reason: GateReason,
  businessUnitId: string | null,
  scope?: ScopeRow | null,
  blockedFrom: string | null = null,
): NotReservable {
  return {
    reservable: false,
    reason,
    businessUnitId,
    blockedFrom,
    lastSuccessfulSyncAt: scope?.last_successful_sync_at ?? null,
    lastManualRunAt: scope?.last_manual_run_at ?? null,
  };
}

/**
 * この日付・このスタッフ(・この設備)で予約を受け付けてよいか。
 *
 * 🔴 有効な接続が1つも無い時は通す。
 *    外部予約サービスに繋がっていない営業単位には外部在庫が存在せず、二重予約の
 *    起きようが無い。ここを閉じると、連携していない顧客の予約まで止まる。
 *    「接続が無い(通す)」と「接続はあるが scope が無い(閉じる)」を区別することが
 *    この関数で一番大事な点。
 *
 * 🔴 接続が2つ以上ある時は AND で見る。1つでも塞がっていれば閉じる。
 *    どの経路からでも二重予約は起きるので、OR にすると穴になる。
 */
export async function getReservability(
  db: D1Database,
  params: ReservabilityParams,
): Promise<Reservability> {
  // 1. 営業単位を決める(fail-closed)。決まらなければ何も判定できない。
  let businessUnitId = params.businessUnitId ?? null;
  if (!businessUnitId) {
    const resolved = await resolveBusinessUnitId(db, params.lineAccountId);
    if (!resolved.ok) return blocked('no_business_unit', null);
    businessUnitId = resolved.businessUnitId;
  }

  // 2. この営業単位に紐づく有効な接続。0件ならここで通す。
  const connectors = await db
    .prepare(
      `SELECT c.id, c.provider, c.readonly_ack
         FROM business_unit_connectors buc
         JOIN connectors c
           ON c.id = buc.connector_id AND c.line_account_id = buc.line_account_id
        WHERE buc.business_unit_id = ? AND buc.line_account_id = ?
          AND buc.is_active = 1 AND c.is_active = 1 AND c.deleted_at IS NULL
        ORDER BY c.id`,
    )
    .bind(businessUnitId, params.lineAccountId)
    .all<ConnectorRow>();
  const active = connectors.results ?? [];
  if (active.length === 0) {
    return { reservable: true, businessUnitId, coverageThrough: null };
  }

  let minCoverage: string | null = null;

  for (const connector of active) {
    // 3. 媒体の能力。scope の状態と違って静的な性質なので先に見る
    //    (「この媒体は空きを取得できない」は運用で直せない＝最も動かない理由)。
    const caps = await db
      .prepare(`SELECT capability FROM provider_capabilities WHERE provider = ?`)
      .bind(connector.provider)
      .all<{ capability: string }>();
    const capabilities = new Set((caps.results ?? []).map((r) => r.capability));
    // read_bookings が無ければ外部の埋まりを読めない＝空きを判定できない。
    if (!capabilities.has('read_bookings')) {
      return blocked('no_capability', businessUnitId);
    }
    // write_booking が無ければHARKの予約を外部に塞げない＝その媒体経由の二重予約を
    // 防げない。顧客が読み取り専用連携を承諾している場合だけ通す。
    if (!capabilities.has('write_booking') && connector.readonly_ack !== 1) {
      return blocked('no_capability', businessUnitId);
    }

    // 4. この staff/resource を覆う scope を、細かい方を優先して1件選ぶ。
    //    スタッフ個別の scope がある時はそれが支配する。個別が塞がっているのに
    //    店舗全体の scope が ready だからと通すと、そのスタッフの枠で二重予約になる。
    const scope = await db
      .prepare(
        `SELECT id, readiness, coverage_through,
                last_successful_sync_at, last_manual_run_at
           FROM sync_scopes
          WHERE line_account_id = ? AND business_unit_id = ? AND connector_id = ?
            AND (staff_id IS NULL OR staff_id = ?)
            AND (resource_id IS NULL OR resource_id = ?)
          ORDER BY (staff_id IS NOT NULL) DESC, (resource_id IS NOT NULL) DESC, id
          LIMIT 1`,
      )
      .bind(params.lineAccountId, businessUnitId, connector.id, params.staffId ?? null, params.resourceId ?? null)
      .first<ScopeRow>();
    if (!scope) return blocked('no_scope', businessUnitId);

    // 5. 販売してよい状態か。判定は VIEW に閉じ込めてあるので、ここでは
    //    「その scope が VIEW に出てくるか」だけを見る。
    const bookable = await db
      .prepare(`SELECT 1 AS ok FROM bookable_scopes_v1 WHERE id = ?`)
      .bind(scope.id)
      .first<{ ok: number }>();
    if (!bookable) {
      // VIEW から落ちた理由を人に見せる。readiness と鮮度は原因が別なので潰さない。
      return blocked(scope.readiness === 'ready' ? 'stale' : 'not_ready', businessUnitId, scope);
    }

    // 6. その日付まで同期が届いているか。
    //    🔑 指示書 §3-1-2 は「coverage_through >= 販売上限」だが、それだと上限日まで
    //       1日でも届いていない時に全日程が閉じる。coverage_through 以前の日付は
    //       検証済みなので、日付単位で見て未同期の後ろ側だけを閉じる。
    if (!scope.coverage_through || scope.coverage_through < params.date) {
      return blocked('coverage_short', businessUnitId, scope, nextDay(scope.coverage_through));
    }
    if (minCoverage === null || scope.coverage_through < minCoverage) {
      minCoverage = scope.coverage_through;
    }
  }

  return { reservable: true, businessUnitId, coverageThrough: minCoverage };
}

/** YYYY-MM-DD の翌日。null なら null(＝一度も同期できていない)。 */
function nextDay(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
