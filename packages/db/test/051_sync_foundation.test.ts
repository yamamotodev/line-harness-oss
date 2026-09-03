import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_051 = '051_sync_foundation.sql';

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

/** 051 の「手前まで」を適用した DB。バックフィルを検証するため 051 は含めない。 */
function setupDbBefore051(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    // 051 以降は適用しない(後続マイグレーションを巻き込まない)
    if (file >= MIGRATION_051) continue;
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

function apply051(db: Database.Database): void {
  execSafe(db, readFileSync(join(MIGRATIONS_DIR, MIGRATION_051), 'utf8'));
}

/**
 * 050 のバックフィルは setup 時点(line_accounts が 0 件)で走り終わっているので、
 * 営業単位はここで明示的に作る。051 の検証は「既に 050 が入っている DB」が前提。
 */
function seedExistingData(db: Database.Database): void {
  db.exec(
    `INSERT INTO line_accounts (id, channel_id, name, channel_secret, channel_access_token)
     VALUES ('accA','chA','テナントA','s','t'), ('accB','chB','テナントB','s','t')`,
  );
  db.exec(
    `INSERT INTO business_units (id, line_account_id, name)
     VALUES ('bu_accA','accA','A店'), ('bu_accB','accB','B店')`,
  );
  db.exec(`INSERT INTO friends (id, line_user_id) VALUES ('f1','U1')`);
  db.exec(
    `INSERT INTO staff (id, line_account_id, name, display_name)
     VALUES ('stA','accA','A','A'), ('stA2','accA','A2','A2'),
            ('stA3','accA','A3','A3'), ('stA4','accA','A4','A4'), ('stB','accB','B','B')`,
  );
  db.exec(
    `INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
     VALUES ('mA','accA','カット',60,8000), ('mB','accB','カット',60,8000)`,
  );
  db.exec(
    `INSERT INTO connectors (id, line_account_id, provider, display_name)
     VALUES ('c_sb','accA','salonboard','SALON BOARD'), ('c_sbB','accB','salonboard','B店の接続')`,
  );
}

/** booking.ts と同じ形の「既存予約と重ならないときだけ入れる」INSERT。 */
function insertBooking(
  db: Database.Database,
  args: { id: string; account: string; staff: string; menu: string; bu: string; start: string; end: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO bookings
         (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at,
          block_ends_at, status, price_at_booking, requested_at, business_unit_id)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (
          SELECT 1 FROM bookings
           WHERE staff_id = ?
             AND status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
        )`,
    )
    .run(
      args.id, args.account, 'f1', args.staff, args.menu,
      args.start, args.end, args.end, 'confirmed', 8000, '2026-09-01T00:00:00Z', args.bu,
      args.staff, args.end, args.start,
    );
  return r.changes;
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function columns(db: Database.Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => (r as { name: string }).name);
}

describe('051_sync_foundation — 同期基盤', () => {
  it('テーブル・VIEW・列を作る', () => {
    const db = setupDbBefore051();
    apply051(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('provider_capabilities','resources','menu_resources',
                       'sync_scopes','sync_runs','job_leases')`,
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      'job_leases',
      'menu_resources',
      'provider_capabilities',
      'resources',
      'sync_runs',
      'sync_scopes',
    ]);

    const views = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(views).toContain('bookable_scopes_v1');

    const bookingCols = columns(db, 'bookings');
    expect(bookingCols).toContain('resource_id');
    expect(bookingCols).toContain('connector_id');
    expect(bookingCols).toContain('external_ref');
    // 既存列は流用せず意味を分ける(Google Calendar 用の枠は残したまま)
    expect(bookingCols).toContain('external_event_id');

    expect(columns(db, 'connector_providers')).toContain('kind');
    expect(columns(db, 'connectors')).toContain('readonly_ack');
  });

  // ------------------------------------------------------------------
  // 既存の予約フローを1ミリも変えないこと
  // ------------------------------------------------------------------

  it('🔴 設備を入れても既存の予約フローの挙動が変わらない（resource_id は NULL のまま）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);

    // 既存と同じ形の INSERT がそのまま通る
    expect(
      insertBooking(db, {
        id: 'b1', account: 'accA', staff: 'stA', menu: 'mA', bu: 'bu_accA',
        start: '2026-09-10T01:00:00Z', end: '2026-09-10T02:00:00Z',
      }),
    ).toBe(1);
    // 同じスタッフの重なりは今までどおり弾かれる(0行 INSERT = 409)
    expect(
      insertBooking(db, {
        id: 'b2', account: 'accA', staff: 'stA', menu: 'mA', bu: 'bu_accA',
        start: '2026-09-10T01:30:00Z', end: '2026-09-10T02:30:00Z',
      }),
    ).toBe(0);
    // 重ならなければ入る
    expect(
      insertBooking(db, {
        id: 'b3', account: 'accA', staff: 'stA', menu: 'mA', bu: 'bu_accA',
        start: '2026-09-10T03:00:00Z', end: '2026-09-10T04:00:00Z',
      }),
    ).toBe(1);

    // 美容室では設備が1行も入らず、予約の resource_id は全部 NULL
    expect(count(db, `SELECT COUNT(*) AS n FROM resources`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM menu_resources`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE resource_id IS NOT NULL`)).toBe(0);
  });

  it('既存の予約は 051 の後もそのまま残る（作り直しをしない）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    insertBooking(db, {
      id: 'b_old', account: 'accA', staff: 'stA', menu: 'mA', bu: 'bu_accA',
      start: '2026-09-10T01:00:00Z', end: '2026-09-10T02:00:00Z',
    });
    apply051(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE id='b_old'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE business_unit_id IS NULL`)).toBe(0);
  });

  // ------------------------------------------------------------------
  // fail-closed（未検証の事実を DB に書かない）
  // ------------------------------------------------------------------

  it('🔴 scope を勝手に作らない（0件が正常。bootstrap を通して初めて作る）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM sync_scopes`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM sync_runs`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM job_leases`)).toBe(0);
  });

  it('🔴 scope の既定は blocked / idle（既存 connector を ready にしない）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    db.exec(
      `INSERT INTO sync_scopes (id, line_account_id, business_unit_id, connector_id, staff_id)
       VALUES ('sc1','accA','bu_accA','c_sb','stA')`,
    );
    const row = db
      .prepare(`SELECT readiness, phase, fresh_until FROM sync_scopes WHERE id='sc1'`)
      .get() as { readiness: string; phase: string; fresh_until: string | null };
    expect(row.readiness).toBe('blocked');
    expect(row.phase).toBe('idle');
    expect(row.fresh_until).toBeNull();
  });

  it('🔴 読み取り専用連携の承諾は既定で「無い」', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM connectors WHERE readonly_ack = 0`)).toBe(2);
  });

  // ------------------------------------------------------------------
  // VIEW（判定を1箇所に閉じ込める）
  // ------------------------------------------------------------------

  it('🔴 bookable_scopes_v1 は ready かつ fresh な scope だけを返す', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    const scope = (id: string, staff: string, readiness: string, freshUntil: string | null) =>
      db
        .prepare(
          `INSERT INTO sync_scopes
             (id, line_account_id, business_unit_id, connector_id, staff_id, readiness, fresh_until)
           VALUES (?, 'accA','bu_accA','c_sb', ?, ?, ?)`,
        )
        .run(id, staff, readiness, freshUntil);

    scope('ok', 'stA', 'ready', '2099-01-01T00:00:00.000');
    scope('blocked', 'stA2', 'blocked', '2099-01-01T00:00:00.000');
    scope('stale', 'stA3', 'ready', '2000-01-01T00:00:00.000');   // dead-man switch が閉じる
    scope('nofresh', 'stA4', 'ready', null);                       // 一度も同期していない

    const ids = db
      .prepare(`SELECT id FROM bookable_scopes_v1 ORDER BY id`)
      .all()
      .map((r) => (r as { id: string }).id);
    expect(ids).toEqual(['ok']);
  });

  it('🔴 接続を止めた(is_active=0 / 論理削除)瞬間に VIEW から消える', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    db.exec(
      `INSERT INTO sync_scopes
         (id, line_account_id, business_unit_id, connector_id, staff_id, readiness, fresh_until)
       VALUES ('sc1','accA','bu_accA','c_sb','stA','ready','2099-01-01T00:00:00.000')`,
    );
    expect(count(db, `SELECT COUNT(*) AS n FROM bookable_scopes_v1`)).toBe(1);

    db.exec(`UPDATE connectors SET is_active = 0 WHERE id='c_sb'`);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookable_scopes_v1`)).toBe(0);

    db.exec(`UPDATE connectors SET is_active = 1, deleted_at = '2026-09-03T00:00:00.000' WHERE id='c_sb'`);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookable_scopes_v1`)).toBe(0);
  });

  // ------------------------------------------------------------------
  // 一意性とテナント境界
  // ------------------------------------------------------------------

  it('🔴 同じ組み合わせの scope を2行作れない（staff/resource が NULL でも）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    const insert = (id: string, staff: string | null) =>
      db
        .prepare(
          `INSERT INTO sync_scopes (id, line_account_id, business_unit_id, connector_id, staff_id)
           VALUES (?, 'accA','bu_accA','c_sb', ?)`,
        )
        .run(id, staff);

    insert('sc1', 'stA');
    expect(() => insert('sc2', 'stA')).toThrow();

    // NULL 同士も「同じ組み合わせ」として弾く(COALESCE で正規化しているため)
    insert('sc3', null);
    expect(() => insert('sc4', null)).toThrow();
  });

  it('🔴 テナントを跨いだ 店舗 × 設備 は複合外部キーが拒否する', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    expect(() =>
      db.exec(
        `INSERT INTO resources (id, line_account_id, business_unit_id, name)
         VALUES ('r1','accA','bu_accB','B店のベッド')`,
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO resources (id, line_account_id, business_unit_id, name)
         VALUES ('r1','accA','bu_accA','A店のベッド')`,
      ),
    ).not.toThrow();
  });

  it('🔴 テナントを跨いだ メニュー × 設備 も拒否する', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    db.exec(
      `INSERT INTO resources (id, line_account_id, business_unit_id, name)
       VALUES ('r1','accA','bu_accA','ベッドA')`,
    );
    // accB のメニューを accA の設備に紐づけようとする
    expect(() =>
      db.exec(
        `INSERT INTO menu_resources (menu_id, resource_id, line_account_id)
         VALUES ('mB','r1','accA')`,
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO menu_resources (menu_id, resource_id, line_account_id)
         VALUES ('mA','r1','accA')`,
      ),
    ).not.toThrow();
  });

  it('🔴 テナントを跨いだ scope も拒否する', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    // accA の店舗を accB の接続に紐づけようとする
    expect(() =>
      db.exec(
        `INSERT INTO sync_scopes (id, line_account_id, business_unit_id, connector_id)
         VALUES ('sc1','accA','bu_accA','c_sbB')`,
      ),
    ).toThrow();
    // accB のスタッフを accA の scope に入れようとする
    expect(() =>
      db.exec(
        `INSERT INTO sync_scopes (id, line_account_id, business_unit_id, connector_id, staff_id)
         VALUES ('sc2','accA','bu_accA','c_sb','stB')`,
      ),
    ).toThrow();
  });

  it('実在しない scope_id の実行履歴は外部キーが拒否する', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    expect(() =>
      db.exec(
        `INSERT INTO sync_runs (id, scope_id, generation, run_type, status, started_at)
         VALUES ('run1','typo_123',1,'bootstrap','running','2026-09-03T00:00:00.000')`,
      ),
    ).toThrow();
  });

  // ------------------------------------------------------------------
  // バックフィル
  // ------------------------------------------------------------------

  it('provider の種別を実物に合わせて個別に入れる（BM はハブなので booking_site ではない）', () => {
    const db = setupDbBefore051();
    apply051(db);
    const kinds = Object.fromEntries(
      db
        .prepare(`SELECT id, kind FROM connector_providers ORDER BY id`)
        .all()
        .map((r) => [(r as { id: string }).id, (r as { kind: string }).kind]),
    );
    expect(kinds).toEqual({
      beautymerit: 'salon_manager',
      rakuten_beauty: 'booking_site',
      salonboard: 'booking_site',
    });
  });

  it('capability を provider ごとに入れる（read_bookings / write_booking が無いと gate が閉じる）', () => {
    const db = setupDbBefore051();
    apply051(db);
    const caps = (provider: string) =>
      db
        .prepare(`SELECT capability FROM provider_capabilities WHERE provider=? ORDER BY capability`)
        .all(provider)
        .map((r) => (r as { capability: string }).capability);
    expect(caps('salonboard')).toEqual(['cancel_booking', 'read_bookings', 'read_shifts', 'write_booking']);
    expect(caps('rakuten_beauty')).toEqual(['cancel_booking', 'read_bookings', 'read_shifts', 'write_booking']);
    // BM の一元管理画面に「取得：シフト」に当たる行は無い(BM は書く側)
    expect(caps('beautymerit')).toEqual(['cancel_booking', 'read_bookings', 'write_booking']);
  });

  it('新しい連携先は INSERT 1行で足せる（capability は明示的に入れる）', () => {
    const db = setupDbBefore051();
    apply051(db);
    db.exec(`INSERT INTO connector_providers (id, label, kind) VALUES ('minimo','minimo','booking_site')`);
    // 既定に黙って乗らない。capability は入れるまで 0 件 = gate は閉じたまま
    expect(count(db, `SELECT COUNT(*) AS n FROM provider_capabilities WHERE provider='minimo'`)).toBe(0);
    // 表記ゆれは参照テーブルが拒否する(050 から引き継いだ性質)
    expect(() =>
      db.exec(`INSERT INTO provider_capabilities (provider, capability) VALUES ('minmo','read_bookings')`),
    ).toThrow();
  });

  it('再実行しても増えない（冪等）', () => {
    const db = setupDbBefore051();
    seedExistingData(db);
    apply051(db);
    apply051(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM connector_providers`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS n FROM provider_capabilities`)).toBe(11);
    expect(count(db, `SELECT COUNT(*) AS n FROM sync_scopes`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM connectors WHERE readonly_ack = 0`)).toBe(2);
  });

  it('新規インストール（データが無いDB）でも provider マスタだけが入る', () => {
    const db = setupDbBefore051();
    apply051(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM resources`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM sync_scopes`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM provider_capabilities`)).toBe(11);
  });
});
