import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKING_CONFLICT_NOT_EXISTS, bookingConflictParams } from '../src/booking-conflict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');

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

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  db.exec(
    `INSERT INTO line_accounts (id, channel_id, name, channel_secret, channel_access_token)
     VALUES ('accA','chA','テナントA','s','t')`,
  );
  db.exec(`INSERT INTO business_units (id, line_account_id, name) VALUES ('bu1','accA','A店')`);
  db.exec(`INSERT INTO friends (id, line_user_id) VALUES ('f1','U1')`);
  db.exec(
    `INSERT INTO staff (id, line_account_id, name, display_name)
     VALUES ('st1','accA','A','A'), ('st2','accA','B','B')`,
  );
  db.exec(
    `INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
     VALUES ('m1','accA','カット',60,8000)`,
  );
  db.exec(
    `INSERT INTO resources (id, line_account_id, business_unit_id, name, kind)
     VALUES ('bed1','accA','bu1','ベッドA','bed')`,
  );
  return db;
}

/**
 * ルートと同じ形の「衝突しなければ入れる」INSERT。
 * 🔑 WHERE 句はルートが使うのと同じ定数。写し間違いが起きない。
 */
function tryInsert(
  db: Database.Database,
  args: {
    id: string;
    staffId: string;
    startsAt: string;
    blockEndsAt: string;
    resourceId?: string | null;
  },
): number {
  const stmt = db.prepare(
    `INSERT INTO bookings
       (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at,
        block_ends_at, status, price_at_booking, requested_at, business_unit_id, resource_id)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ${BOOKING_CONFLICT_NOT_EXISTS}`,
  );
  const r = stmt.run(
    args.id,
    'accA',
    'f1',
    args.staffId,
    'm1',
    args.startsAt,
    args.blockEndsAt,
    args.blockEndsAt,
    'confirmed',
    8000,
    '2026-09-01T00:00:00Z',
    'bu1',
    args.resourceId ?? null,
    ...bookingConflictParams({
      blockEndsAt: args.blockEndsAt,
      startsAt: args.startsAt,
      staffId: args.staffId,
      resourceId: args.resourceId ?? null,
    }),
  );
  return r.changes;
}

const T = (h: number) => `2026-09-10T${String(h).padStart(2, '0')}:00:00Z`;

describe('二重予約防止の衝突判定', () => {
  // ------------------------------------------------------------------
  // 設備を使わない（＝美容室）。設備を入れる前と同じ挙動でなければならない。
  // ------------------------------------------------------------------

  it('空いていれば入る', () => {
    const db = setupDb();
    expect(tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(2) })).toBe(1);
  });

  it('🔴 同じスタッフの時間が重なれば入らない（0行 INSERT = 409）', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3) });
    expect(tryInsert(db, { id: 'b2', staffId: 'st1', startsAt: T(2), blockEndsAt: T(4) })).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bookings`).get() as { n: number }).n).toBe(1);
  });

  it('同じスタッフでも時間が重ならなければ入る（境界: 前の block_ends_at と同時刻）', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(2) });
    expect(tryInsert(db, { id: 'b2', staffId: 'st1', startsAt: T(2), blockEndsAt: T(3) })).toBe(1);
  });

  it('スタッフが違えば時間が重なっても入る（設備を使わない場合）', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3) });
    expect(tryInsert(db, { id: 'b2', staffId: 'st2', startsAt: T(1), blockEndsAt: T(3) })).toBe(1);
  });

  it('キャンセル済みの予約は枠を塞がない', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3) });
    db.exec(`UPDATE bookings SET status='cancelled' WHERE id='b1'`);
    expect(tryInsert(db, { id: 'b2', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3) })).toBe(1);
  });

  // ------------------------------------------------------------------
  // 設備を使う（ネイル・まつげ・エステ）
  // ------------------------------------------------------------------

  it('🔴 スタッフが違っても、同じ設備の時間が重なれば入らない', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3), resourceId: 'bed1' });
    // 担当は別人だが、ベッドは1台しか無い
    expect(
      tryInsert(db, { id: 'b2', staffId: 'st2', startsAt: T(2), blockEndsAt: T(4), resourceId: 'bed1' }),
    ).toBe(0);
  });

  it('設備を使っても、同じスタッフの重なりは今までどおり弾く', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3), resourceId: 'bed1' });
    expect(
      tryInsert(db, { id: 'b2', staffId: 'st1', startsAt: T(2), blockEndsAt: T(4), resourceId: null }),
    ).toBe(0);
  });

  it('設備も時間も重ならなければ入る', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(2), resourceId: 'bed1' });
    expect(
      tryInsert(db, { id: 'b2', staffId: 'st2', startsAt: T(2), blockEndsAt: T(3), resourceId: 'bed1' }),
    ).toBe(1);
  });

  it('🔴 設備を指定しない予約は、既存の設備予約に影響されない（美容室が巻き込まれない）', () => {
    const db = setupDb();
    tryInsert(db, { id: 'b1', staffId: 'st1', startsAt: T(1), blockEndsAt: T(3), resourceId: 'bed1' });
    // 設備を使わないメニューの予約は、別スタッフなら通る
    expect(
      tryInsert(db, { id: 'b2', staffId: 'st2', startsAt: T(1), blockEndsAt: T(3), resourceId: null }),
    ).toBe(1);
  });
});
