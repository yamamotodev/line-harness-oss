import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_050 = '050_connectors.sql';

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

/** 050 の「手前まで」を適用した DB。バックフィルを検証するため 050 は含めない。 */
function setupDbBefore050(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    // 050 以降は適用しない。「050 を除く」だと、051 以降の後続マイグレーション
    // (050 が作ったテーブルに依存する) までこの DB に流れ込んで壊れる。
    if (file >= MIGRATION_050) continue;
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

function apply050(db: Database.Database): void {
  execSafe(db, readFileSync(join(MIGRATIONS_DIR, MIGRATION_050), 'utf8'));
}

function seedExistingData(db: Database.Database): void {
  db.exec(
    `INSERT INTO line_accounts (id, channel_id, name, channel_secret, channel_access_token)
     VALUES ('accA','chA','テナントA','s','t'), ('accB','chB','テナントB','s','t')`,
  );
  db.exec(`INSERT INTO friends (id, line_user_id) VALUES ('f1','U1')`);
  db.exec(
    `INSERT INTO staff (id, line_account_id, name, display_name)
     VALUES ('stA','accA','A','A'), ('stA2','accA','A2','A2'), ('stB','accB','B','B')`,
  );
  db.exec(
    `INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
     VALUES ('mA','accA','カット',60,8000), ('mB','accB','カット',60,8000)`,
  );
  const booking = (id: string, acc: string, staff: string, menu: string, day: string) =>
    `INSERT INTO bookings
       (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at,
        block_ends_at, status, price_at_booking, requested_at)
     VALUES ('${id}','${acc}','f1','${staff}','${menu}',
             '2026-09-${day}T01:00:00Z','2026-09-${day}T02:00:00Z','2026-09-${day}T02:10:00Z',
             'confirmed',8000,'2026-09-01T00:00:00Z')`;
  db.exec(booking('b1', 'accA', 'stA', 'mA', '02'));
  db.exec(booking('b2', 'accA', 'stA2', 'mA', '03'));
  db.exec(booking('b3', 'accB', 'stB', 'mB', '04'));
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe('050_connectors — 営業単位と外部接続の分離', () => {
  it('テーブルを作り、bookings に business_unit_id を足す', () => {
    const db = setupDbBefore050();
    apply050(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('business_units','connectors','connector_providers','business_unit_connectors','staff_connectors')`,
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      'business_unit_connectors',
      'business_units',
      'connector_providers',
      'connectors',
      'staff_connectors',
    ]);
    const cols = db
      .prepare(`PRAGMA table_info(bookings)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('business_unit_id');
    // 初版の連番列を作っていないこと（予約の所属は business_unit_id に一本化した）
    expect(cols).not.toContain('connector_id');
  });

  it('既存データをバックフィルし、所属が NULL の予約を 0 にする', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE business_unit_id IS NULL`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM business_units`)).toBe(2);
    // 予約は自分のテナントの店舗に入る（取り違えない）
    expect(
      count(
        db,
        `SELECT COUNT(*) AS n FROM bookings b JOIN business_units u ON u.id = b.business_unit_id
          WHERE u.line_account_id <> b.line_account_id`,
      ),
    ).toBe(0);
  });

  it('外部接続は作らない（0件が正常。実在するときだけ登録する）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM connectors`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM business_unit_connectors`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM staff_connectors`)).toBe(0);
  });

  it('再実行しても増えない（冪等）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    apply050(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM business_units`)).toBe(2);
    expect(count(db, `SELECT COUNT(*) AS n FROM connector_providers`)).toBe(3);
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE business_unit_id IS NULL`)).toBe(0);
  });

  it('新規インストール（データが無いDB）では何も作らない', () => {
    const db = setupDbBefore050();
    apply050(db);
    expect(count(db, `SELECT COUNT(*) AS n FROM business_units`)).toBe(0);
    // provider マスタだけは入る
    expect(count(db, `SELECT COUNT(*) AS n FROM connector_providers`)).toBe(3);
  });

  it('🔴 実在しない所属IDは外部キーが拒否する（値の存在ではなく正しさを守る）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    expect(() => db.exec(`UPDATE bookings SET business_unit_id = 'typo_123' WHERE id = 'b1'`)).toThrow();
    expect(() => db.exec(`UPDATE bookings SET business_unit_id = 'bu_accA' WHERE id = 'b1'`)).not.toThrow();
  });

  it('🔴 テナントを跨いだ staff × connector は複合外部キーが拒否する', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    db.exec(
      `INSERT INTO connectors (id, line_account_id, provider, display_name)
       VALUES ('connB','accB','salonboard','テナントBの接続')`,
    );
    // accA の staff を accB の connector に紐づけようとする
    expect(() =>
      db.exec(
        `INSERT INTO staff_connectors (staff_id, connector_id, line_account_id)
         VALUES ('stA','connB','accA')`,
      ),
    ).toThrow();
    // line_account_id を偽装しても通らない
    expect(() =>
      db.exec(
        `INSERT INTO staff_connectors (staff_id, connector_id, line_account_id)
         VALUES ('stA','connB','accB')`,
      ),
    ).toThrow();
  });

  it('🔴 テナントを跨いだ 店舗 × connector も拒否する', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    db.exec(
      `INSERT INTO connectors (id, line_account_id, provider, display_name)
       VALUES ('connB','accB','salonboard','テナントBの接続')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO business_unit_connectors (business_unit_id, connector_id, line_account_id)
         VALUES ('bu_accA','connB','accA')`,
      ),
    ).toThrow();
  });

  it('provider は参照テーブルで守られる（表記ゆれは拒否・追加は INSERT 1行）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    expect(() =>
      db.exec(
        `INSERT INTO connectors (id, line_account_id, provider, display_name)
         VALUES ('c1','accA','salonbaord','タイポ')`,
      ),
    ).toThrow();
    db.exec(`INSERT INTO connector_providers (id, label) VALUES ('some_new_service','新しい連携先')`);
    expect(() =>
      db.exec(
        `INSERT INTO connectors (id, line_account_id, provider, display_name)
         VALUES ('c2','accA','some_new_service','新連携')`,
      ),
    ).not.toThrow();
  });

  it('1つの店舗が2つの外部接続を持てる（Relais の実配置）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    db.exec(
      `INSERT INTO connectors (id, line_account_id, provider, display_name)
       VALUES ('c_sb','accA','salonboard','SALON BOARD'), ('c_bm','accA','beautymerit','BeautyMerit')`,
    );
    db.exec(
      `INSERT INTO business_unit_connectors (business_unit_id, connector_id, line_account_id, external_shop_ref)
       VALUES ('bu_accA','c_sb','accA','shop-1'), ('bu_accA','c_bm','accA','shop-1-bm')`,
    );
    expect(count(db, `SELECT COUNT(*) AS n FROM business_unit_connectors WHERE business_unit_id='bu_accA'`)).toBe(2);
    // 予約は1つの店舗に属したまま、同期先だけが2つになる
    expect(count(db, `SELECT COUNT(*) AS n FROM bookings WHERE business_unit_id='bu_accA'`)).toBe(2);
  });

  it('1つの外部接続が複数店舗を持てる（1認証で複数店舗を扱うサービス向け）', () => {
    const db = setupDbBefore050();
    seedExistingData(db);
    apply050(db);
    db.exec(
      `INSERT INTO business_units (id, line_account_id, name) VALUES ('bu_accA_2','accA','2号店')`,
    );
    db.exec(
      `INSERT INTO connectors (id, line_account_id, provider, display_name)
       VALUES ('c_sb','accA','salonboard','SALON BOARD')`,
    );
    db.exec(
      `INSERT INTO business_unit_connectors (business_unit_id, connector_id, line_account_id, external_shop_ref)
       VALUES ('bu_accA','c_sb','accA','shop-1'), ('bu_accA_2','c_sb','accA','shop-2')`,
    );
    expect(count(db, `SELECT COUNT(*) AS n FROM business_unit_connectors WHERE connector_id='c_sb'`)).toBe(2);
  });
});
