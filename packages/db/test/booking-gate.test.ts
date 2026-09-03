import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReservability } from '../src/booking-gate.js';

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

/**
 * better-sqlite3 を D1Database の見た目に合わせる最小の shim。
 * 🔑 gate はほぼ全部がSQLなので、D1のモックでは何も検証できない。本物のSQLiteに
 *    schema.sql + 全マイグレーションを流して、VIEW と外部キーを実際に効かせる。
 */
function asD1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          params = p;
          return api;
        },
        async first<T>() {
          return (stmt.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: stmt.all(...(params as never[])) as T[], success: true, meta: {} };
        },
        async run() {
          const r = stmt.run(...(params as never[]));
          return { success: true, meta: { changes: r.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
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
  db.exec(
    `INSERT INTO staff (id, line_account_id, name, display_name)
     VALUES ('st1','accA','A','A'), ('st2','accA','B','B')`,
  );
  return db;
}

/** 接続を1つ足して business_unit に紐づける。 */
function addConnector(
  db: Database.Database,
  id: string,
  opts: { provider?: string; readonlyAck?: number; isActive?: number; deletedAt?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO connectors (id, line_account_id, provider, display_name, readonly_ack, is_active, deleted_at)
     VALUES (?, 'accA', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.provider ?? 'salonboard',
    id,
    opts.readonlyAck ?? 0,
    opts.isActive ?? 1,
    opts.deletedAt ?? null,
  );
  db.prepare(
    `INSERT INTO business_unit_connectors (business_unit_id, connector_id, line_account_id)
     VALUES ('bu1', ?, 'accA')`,
  ).run(id);
}

const FUTURE = '2099-01-01T00:00:00.000';
const PAST = '2000-01-01T00:00:00.000';

/** scope を1つ足す。既定は「完全に健全」。 */
function addScope(
  db: Database.Database,
  id: string,
  opts: {
    connectorId?: string;
    staffId?: string | null;
    resourceId?: string | null;
    readiness?: string;
    freshUntil?: string | null;
    coverageThrough?: string | null;
    lastSuccessfulSyncAt?: string | null;
    lastManualRunAt?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO sync_scopes
       (id, line_account_id, business_unit_id, connector_id, staff_id, resource_id,
        readiness, fresh_until, coverage_through, last_successful_sync_at, last_manual_run_at)
     VALUES (?, 'accA', 'bu1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.connectorId ?? 'c1',
    opts.staffId ?? null,
    opts.resourceId ?? null,
    opts.readiness ?? 'ready',
    opts.freshUntil === undefined ? FUTURE : opts.freshUntil,
    opts.coverageThrough === undefined ? '2099-12-31' : opts.coverageThrough,
    opts.lastSuccessfulSyncAt ?? null,
    opts.lastManualRunAt ?? null,
  );
}

const DATE = '2026-09-10';

function ask(db: Database.Database, over: Partial<Parameters<typeof getReservability>[1]> = {}) {
  return getReservability(asD1(db), {
    lineAccountId: 'accA',
    date: DATE,
    staffId: 'st1',
    ...over,
  });
}

describe('getReservability — 予約可否の関門', () => {
  // ------------------------------------------------------------------
  // 🔴 いちばん大事な分岐: 接続が無い ≠ scope が無い
  // ------------------------------------------------------------------

  it('🔴 有効な接続が1つも無ければ通す（外部在庫が無いので二重予約が起きようが無い）', async () => {
    const db = setupDb();
    const r = await ask(db);
    expect(r).toEqual({ reservable: true, businessUnitId: 'bu1', coverageThrough: null });
  });

  it('🔴 接続はあるが scope が無ければ閉じる（no_scope）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    const r = await ask(db);
    expect(r.reservable).toBe(false);
    expect((r as { reason: string }).reason).toBe('no_scope');
  });

  it('🔴 接続を止めてあれば「接続が無い」と同じ扱いで通す', async () => {
    const db = setupDb();
    addConnector(db, 'c1', { isActive: 0 });
    expect((await ask(db)).reservable).toBe(true);
    const db2 = setupDb();
    addConnector(db2, 'c1', { deletedAt: '2026-09-01T00:00:00.000' });
    expect((await ask(db2)).reservable).toBe(true);
  });

  // ------------------------------------------------------------------
  // 営業単位
  // ------------------------------------------------------------------

  it('営業単位が0件なら閉じる（no_business_unit）', async () => {
    const db = setupDb();
    db.exec(`DELETE FROM business_unit_connectors`);
    db.exec(`DELETE FROM business_units`);
    const r = await ask(db);
    expect(r).toMatchObject({ reservable: false, reason: 'no_business_unit', businessUnitId: null });
  });

  it('🔴 営業単位が2件以上なら閉じる（先頭を選ばない）', async () => {
    const db = setupDb();
    db.exec(`INSERT INTO business_units (id, line_account_id, name) VALUES ('bu2','accA','B店')`);
    const r = await ask(db);
    expect(r).toMatchObject({ reservable: false, reason: 'no_business_unit' });
  });

  it('営業単位を渡された時は解決しない（呼び出し側が既に決めている）', async () => {
    const db = setupDb();
    db.exec(`INSERT INTO business_units (id, line_account_id, name) VALUES ('bu2','accA','B店')`);
    // 曖昧でも、明示的に渡されていれば通る
    const r = await ask(db, { businessUnitId: 'bu1' });
    expect(r.reservable).toBe(true);
  });

  // ------------------------------------------------------------------
  // scope の状態
  // ------------------------------------------------------------------

  it('scope が blocked なら閉じる（not_ready）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { readiness: 'blocked' });
    expect(await ask(db)).toMatchObject({ reservable: false, reason: 'not_ready' });
  });

  it('🔴 fresh_until を過ぎたら閉じる（dead-man switch）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { freshUntil: PAST, lastSuccessfulSyncAt: '2026-09-01T10:00:00.000' });
    expect(await ask(db)).toMatchObject({
      reservable: false,
      reason: 'stale',
      lastSuccessfulSyncAt: '2026-09-01T10:00:00.000',
    });
  });

  it('🔴 一度も同期していない（fresh_until が NULL）なら閉じる', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { freshUntil: null });
    expect(await ask(db)).toMatchObject({ reservable: false, reason: 'stale' });
  });

  it('自動と手動の時刻を別々に返す（表示で混ぜないため）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', {
      readiness: 'blocked',
      lastSuccessfulSyncAt: '2026-09-01T10:00:00.000',
      lastManualRunAt: '2026-09-03T18:00:00.000',
    });
    expect(await ask(db)).toMatchObject({
      lastSuccessfulSyncAt: '2026-09-01T10:00:00.000',
      lastManualRunAt: '2026-09-03T18:00:00.000',
    });
  });

  // ------------------------------------------------------------------
  // coverage
  // ------------------------------------------------------------------

  it('🔴 その日付まで同期が届いていなければ閉じ、どこから未同期かを返す', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { coverageThrough: '2026-09-09' });
    expect(await ask(db)).toMatchObject({
      reservable: false,
      reason: 'coverage_short',
      blockedFrom: '2026-09-10',
    });
  });

  it('coverage_through 当日ちょうどは通る（境界）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { coverageThrough: DATE });
    expect(await ask(db)).toMatchObject({ reservable: true, coverageThrough: DATE });
  });

  it('coverage_through が NULL なら閉じる（blockedFrom は null）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { coverageThrough: null });
    expect(await ask(db)).toMatchObject({
      reservable: false,
      reason: 'coverage_short',
      blockedFrom: null,
    });
  });

  // ------------------------------------------------------------------
  // capability
  // ------------------------------------------------------------------

  it('🔴 read_bookings が無い媒体は閉じる（空きを判定できない）', async () => {
    const db = setupDb();
    db.exec(
      `INSERT INTO connector_providers (id, label, kind) VALUES ('hairlog','ヘアログ','content_only')`,
    );
    addConnector(db, 'c1', { provider: 'hairlog' });
    addScope(db, 's1');
    expect(await ask(db)).toMatchObject({ reservable: false, reason: 'no_capability' });
  });

  it('🔴 write_booking が無く承諾も無ければ閉じる（外部を塞げない＝二重予約を防げない）', async () => {
    const db = setupDb();
    db.exec(`INSERT INTO connector_providers (id, label, kind) VALUES ('readonly_site','読取専用','booking_site')`);
    db.exec(
      `INSERT INTO provider_capabilities (provider, capability) VALUES ('readonly_site','read_bookings')`,
    );
    addConnector(db, 'c1', { provider: 'readonly_site' });
    addScope(db, 's1');
    expect(await ask(db)).toMatchObject({ reservable: false, reason: 'no_capability' });
  });

  it('write_booking が無くても読み取り専用連携の承諾があれば通す', async () => {
    const db = setupDb();
    db.exec(`INSERT INTO connector_providers (id, label, kind) VALUES ('readonly_site','読取専用','booking_site')`);
    db.exec(
      `INSERT INTO provider_capabilities (provider, capability) VALUES ('readonly_site','read_bookings')`,
    );
    addConnector(db, 'c1', { provider: 'readonly_site', readonlyAck: 1 });
    addScope(db, 's1');
    expect((await ask(db)).reservable).toBe(true);
  });

  // ------------------------------------------------------------------
  // 接続が複数（AND で見る）
  // ------------------------------------------------------------------

  it('🔴 接続が2つあって片方が塞がっていれば閉じる（AND。OR にすると穴になる）', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addConnector(db, 'c2', { provider: 'beautymerit' });
    addScope(db, 's1', { connectorId: 'c1' });
    addScope(db, 's2', { connectorId: 'c2', readiness: 'blocked' });
    expect(await ask(db)).toMatchObject({ reservable: false, reason: 'not_ready' });
  });

  it('接続が2つとも健全なら通り、coverage は短い方に合わせる', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addConnector(db, 'c2', { provider: 'beautymerit' });
    addScope(db, 's1', { connectorId: 'c1', coverageThrough: '2026-12-31' });
    addScope(db, 's2', { connectorId: 'c2', coverageThrough: '2026-10-31' });
    expect(await ask(db)).toEqual({
      reservable: true,
      businessUnitId: 'bu1',
      coverageThrough: '2026-10-31',
    });
  });

  // ------------------------------------------------------------------
  // scope の粒度（細かい方が支配する）
  // ------------------------------------------------------------------

  it('店舗全体の scope（staff_id が NULL）はどのスタッフも覆う', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's1', { staffId: null });
    expect((await ask(db, { staffId: 'st2' })).reservable).toBe(true);
  });

  it('🔴 スタッフ個別の scope が塞がっていれば、店舗全体が ready でも閉じる', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's_all', { staffId: null });
    addScope(db, 's_st1', { staffId: 'st1', readiness: 'blocked' });
    // st1 は個別 scope が支配して閉じる
    expect(await ask(db, { staffId: 'st1' })).toMatchObject({
      reservable: false,
      reason: 'not_ready',
    });
    // 個別 scope を持たない st2 は店舗全体の scope で通る
    expect((await ask(db, { staffId: 'st2' })).reservable).toBe(true);
  });

  it('他スタッフの scope は自分の判定に影響しない', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    addScope(db, 's_st2', { staffId: 'st2', readiness: 'blocked' });
    // st1 を覆う scope が無い → no_scope（st2 の blocked を拾ってはいけない）
    expect(await ask(db, { staffId: 'st1' })).toMatchObject({
      reservable: false,
      reason: 'no_scope',
    });
  });

  it('設備を指定しても、設備を持たない scope（resource_id が NULL）が覆う', async () => {
    const db = setupDb();
    addConnector(db, 'c1');
    db.exec(
      `INSERT INTO resources (id, line_account_id, business_unit_id, name) VALUES ('r1','accA','bu1','ベッドA')`,
    );
    addScope(db, 's1', { staffId: null, resourceId: null });
    expect((await ask(db, { resourceId: 'r1' })).reservable).toBe(true);
  });
});
