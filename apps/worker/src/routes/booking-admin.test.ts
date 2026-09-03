import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { GateReason, Reservability } from '@line-crm/db';

interface AvailabilityByStaff {
  staff_id: string;
  display_name: string;
  slots: { date: string; start: string; end: string }[];
}

const availabilityMocks = {
  computeSlots: vi.fn(() => [] as { start: string; end: string }[]),
  getAvailability: vi.fn(
    async (): Promise<{ by_staff: AvailabilityByStaff[] }> => ({
      by_staff: [{ staff_id: 's1', display_name: 'A', slots: [] }],
    }),
  ),
};
vi.mock('../services/availability.js', () => availabilityMocks);

const notifierMocks = { sendBookingNotification: vi.fn() };
vi.mock('../services/booking-notifier.js', () => notifierMocks);

// 予約可否の関門(gate)。既定は「通す」。
// 🔑 gate の判定そのもの（接続0件は通す・scope が blocked なら閉じる 等）は
//    packages/db/test/booking-gate.test.ts が本物のSQLiteで検証している。
//    ここで検証するのは「ルートが gate を呼び、その答えに従うか」だけ。
//    層を分けないと、SQL断片マッチのモックで gate の中身を再現することになり、
//    何も検証していないテストになる。
const gateMocks = {
  getReservability: vi.fn(
    async (): Promise<Reservability> => ({
      reservable: true,
      businessUnitId: 'bu_acc1',
      coverageThrough: null,
    }),
  ),
};
vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return { ...actual, getReservability: gateMocks.getReservability };
});

/** gate が閉じる応答。reason だけ差し替えて使う。 */
function blockedGate(reason: GateReason, over: Record<string, unknown> = {}): Reservability {
  return {
    reservable: false,
    reason,
    businessUnitId: 'bu_acc1',
    blockedFrom: null,
    lastSuccessfulSyncAt: null,
    lastManualRunAt: null,
    ...over,
  };
}

const { default: booking } = await import('./booking.js');

beforeEach(() => {
  // 🔑 呼び出し回数まで主張するテストがあるので、履歴も毎回消す。
  gateMocks.getReservability.mockClear();
  gateMocks.getReservability.mockResolvedValue({
    reservable: true,
    businessUnitId: 'bu_acc1',
    coverageThrough: null,
  });
  availabilityMocks.getAvailability.mockResolvedValue({
    by_staff: [{ staff_id: 's1', display_name: 'A', slots: [] }],
  });
});

function makeApp(db: unknown) {
  const app = new Hono();
  app.route('/', booking);
  return { app, env: { DB: db } };
}

const emptyDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
  }),
};

describe('GET /api/booking/admin/menus/:id/staff', () => {
  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/menus/m1/staff', {}, env);
    expect(res.status).toBe(400);
  });

  test('200 with staff list', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ id: 's1', display_name: 'スタッフA' }] }),
        }),
      }),
    };
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/menus/m1/staff?account_id=acc1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staff: unknown[] };
    expect(body.staff).toHaveLength(1);
  });
});

describe('GET /api/booking/admin/availability', () => {
  test('400 without params', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/availability?account_id=acc1', {}, env);
    expect(res.status).toBe(400);
  });

  test('200 delegates to getAvailability with minLeadTimeMinutes 0', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', menuId: 'm1', minLeadTimeMinutes: 0 }),
    );
  });

  test('400 when range wider than 28 days', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-01&to=2026-08-15',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  // 🔴 表示側の gate。ここを閉じないと、人が画面を見て手で予約を入れる。
  //    確定側(POST)だけを閉じても穴は塞がらない。

  test('🔴 A: gate が閉じたスタッフは枠を出さず、理由と最終同期時刻を返す', async () => {
    availabilityMocks.getAvailability.mockResolvedValue({
      by_staff: [{ staff_id: 's1', display_name: 'A', slots: [{ date: '2026-07-08', start: '11:00', end: '12:00' }] }],
    });
    gateMocks.getReservability.mockResolvedValue(
      blockedGate('stale', {
        lastSuccessfulSyncAt: '2026-09-01T10:00:00.000',
        lastManualRunAt: '2026-09-03T18:00:00.000',
      }),
    );
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      by_staff: { slots: unknown[] }[];
      gate: { reservable: boolean; blocked_staff: { staff_id: string; reason: string; last_successful_sync_at: string; last_manual_run_at: string }[] };
    };
    // 枠は出さない
    expect(body.by_staff[0].slots).toEqual([]);
    // 🔑 ただし空欄で終わらせない。理由を載せる（空欄だと「空きが無い」と読まれる）
    expect(body.gate.reservable).toBe(false);
    expect(body.gate.blocked_staff[0]).toMatchObject({
      staff_id: 's1',
      reason: 'stale',
      // 自動と手動は別フィールドのまま返す（表示で混ぜないため）
      last_successful_sync_at: '2026-09-01T10:00:00.000',
      last_manual_run_at: '2026-09-03T18:00:00.000',
    });
  });

  test('🔴 A: coverage_through より後の日付の枠は出さない', async () => {
    availabilityMocks.getAvailability.mockResolvedValue({
      by_staff: [
        {
          staff_id: 's1',
          display_name: 'A',
          slots: [
            { date: '2026-07-08', start: '11:00', end: '12:00' },
            { date: '2026-07-10', start: '11:00', end: '12:00' },
            { date: '2026-07-14', start: '11:00', end: '12:00' },
          ],
        },
      ],
    });
    gateMocks.getReservability.mockResolvedValue({
      reservable: true,
      businessUnitId: 'bu_acc1',
      coverageThrough: '2026-07-10',
    });
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    const body = (await res.json()) as { by_staff: { slots: { date: string }[] }[]; gate: { coverage_through: string } };
    expect(body.by_staff[0].slots.map((s) => s.date)).toEqual(['2026-07-08', '2026-07-10']);
    expect(body.gate.coverage_through).toBe('2026-07-10');
  });

  test('🔴 B: gate をスタッフごとに呼んでいる（店舗単位で1回ではない）', async () => {
    availabilityMocks.getAvailability.mockResolvedValue({
      by_staff: [
        { staff_id: 's1', display_name: 'A', slots: [] },
        { staff_id: 's2', display_name: 'B', slots: [] },
      ],
    });
    const { app, env } = makeApp(emptyDb);
    await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    // scope の粒度がスタッフ単位なので、店舗単位で1回だけ判定すると
    // 「スタッフAだけ止まっている」時に全員分を閉じてしまう
    expect(gateMocks.getReservability).toHaveBeenCalledTimes(2);
    for (const staffId of ['s1', 's2']) {
      expect(gateMocks.getReservability).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lineAccountId: 'acc1', staffId, date: '2026-07-08' }),
      );
    }
  });
});

// ----------------------------------------------------------------
// POST /api/booking/admin/bookings

type Handler = {
  first?: unknown;
  all?: { results: unknown[] };
  run?: { meta: { changes: number } };
};

// SQL 断片マッチで応答を返す scripted D1。マッチしない SQL は空応答。
function scriptedDb(handlers: [string, Handler][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          const h = handlers.find(([frag]) => sql.includes(frag))?.[1] ?? {};
          return {
            first: async () => h.first ?? null,
            all: async () => h.all ?? { results: [] },
            run: async () => h.run ?? { meta: { changes: 0 } },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts;
    },
  };
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe('POST /api/booking/admin/bookings', () => {
  // Always 7 days in the future at 02:00Z (= JST 11:00, inside the mocked
  // 10:00-19:00 shift). A fixed date here becomes a time bomb: the route
  // rejects past slots with 422 once the calendar catches up.
  const futureStartsAt = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    d.setUTCHours(2, 0, 0, 0);
    return d.toISOString();
  })();
  const validBody = {
    friend_id: 'f1',
    menu_id: 'm1',
    staff_id: 's1',
    starts_at: futureStartsAt, // JST 11:00
  };

  // businessUnits は resolveBusinessUnitId が見る候補。既定は「1件に決まる」。
  // 0件 / 2件以上を渡すと fail-closed のガードが働く側を再現できる。
  function happyDb(insertChanges = 1, businessUnits: unknown[] = [{ id: 'bu_acc1' }]) {
    return scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: { ok: 1 } }],
      [
        'FROM menus m',
        {
          first: {
            duration_minutes: 60,
            buffer_after_minutes: 10,
            dur: 60,
            price: 8000,
            is_offered: 1,
          },
        },
      ],
      ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
      ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
      // 予約は必ず business_unit に属する(migration 050)。ルートは書き込みの手前で
      // resolveBusinessUnitId を通し、決められなければ 503 で予約を作らない。
      // 🔴 この行が無いと候補0件 = no_business_unit となり、全部 503 になる。
      ['FROM business_units', { all: { results: businessUnits } }],
      ['INSERT INTO bookings', { run: { meta: { changes: insertChanges } } }],
    ]);
  }

  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/bookings',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(400);
  });

  test('404 when friend not found', async () => {
    const db = scriptedDb([['FROM friends', { first: null }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
  });

  test('201 creates confirmed booking and inserts reminders', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking_id: string; status: string };
    expect(body.status).toBe('confirmed');
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('confirmed');
    // booking_reminders INSERT が走っている(未来の予約なので day_before + hours_before)
    const reminders = db.calls.filter((c) => c.sql.includes('INSERT INTO booking_reminders'));
    expect(reminders.length).toBeGreaterThan(0);
  });

  test('409 on slot conflict (atomic insert 0 rows)', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb(0);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(409);
  });

  // --------------------------------------------------------------
  // 🔴 gate（ガードが効く側）— ミューテーションテスト
  //
  // 検証したいのはステータスコードではなく「予約が1件も作られないこと」。
  // INSERT のモックは changes:1 を返したままにしてあるので、gate を無視すれば
  // 201 になってこのテストが落ちる。
  //
  // A(挙動) と B(結線) を対で置く。A だけだと「gate を消して別の理由で 503 に
  // なる」実装でも通ってしまうので、B で gate が実際に判断していることを固定する。
  //
  // 📘 fail-closed のガードには必ず「止まる側」のテストを付ける（2026-09-03 の決定）。
  //    cdb3cfb がこれを付けなかったせいで3件が赤いまま残り、後から「元からの赤か、
  //    自分が増やした赤か」を判別できなくなった。

  test('🔴 A: gate が閉じたら 503・予約を作らない（no_business_unit）', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    gateMocks.getReservability.mockResolvedValue(blockedGate('no_business_unit'));
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      { method: 'POST', body: JSON.stringify(validBody), headers: { 'Content-Type': 'application/json' } },
      env,
      execCtx,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'booking_unavailable', reason: 'no_business_unit' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('🔴 A: gate が閉じたら 503・予約を作らない（stale＝同期が止まっている）', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    gateMocks.getReservability.mockResolvedValue(blockedGate('stale'));
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      { method: 'POST', body: JSON.stringify(validBody), headers: { 'Content-Type': 'application/json' } },
      env,
      execCtx,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'booking_unavailable', reason: 'stale' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('🔴 B: gate を、その予約のスタッフと日付で呼んでいる', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const { app, env } = makeApp(happyDb());
    await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      { method: 'POST', body: JSON.stringify(validBody), headers: { 'Content-Type': 'application/json' } },
      env,
      execCtx,
    );
    const jstDate = new Date(new Date(futureStartsAt).getTime() + 9 * 3600_000)
      .toISOString()
      .slice(0, 10);
    expect(gateMocks.getReservability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', staffId: 's1', date: jstDate }),
    );
  });

  test('🔴 B: gate が返した business_unit で予約を作っている', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    gateMocks.getReservability.mockResolvedValue({
      reservable: true,
      businessUnitId: 'bu_from_gate',
      coverageThrough: null,
    });
    const db = happyDb();
    const { app, env } = makeApp(db);
    await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      { method: 'POST', body: JSON.stringify(validBody), headers: { 'Content-Type': 'application/json' } },
      env,
      execCtx,
    );
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('bu_from_gate');
  });

  test('422 when slot not in availability', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '14:00', end: '15:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(422);
  });

  test('404 when staff belongs to another account', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    // friend exists, but the staff-in-account assertion returns no row.
    const db = scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: null }],
    ]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('staff_not_found');
  });

  test('existing-bookings window uses correct JST bounds for a September date', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    // September exercises the old `.replace('-09', ...)` mangling bug, but the
    // year must stay in the future (past slots are rejected with 422 before the
    // window query runs) — pick this year's Sep 10 or next year's once passed.
    const now = new Date();
    const sepYear =
      now.getTime() < Date.UTC(now.getUTCFullYear(), 8, 1) // before Sep 1
        ? now.getUTCFullYear()
        : now.getUTCFullYear() + 1;
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({ ...validBody, starts_at: `${sepYear}-09-10T02:00:00.000Z` }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    // The busy-window query must bind real ISO timestamps, never a corrupted
    // string from the old `.replace('-09', ...)` (which mangled September dates).
    const windowQuery = db.calls.find(
      (c) => c.sql.includes('SELECT starts_at, block_ends_at FROM bookings'),
    );
    const [, endUtc, startUtc] = windowQuery!.params as [string, string, string];
    expect(startUtc).toBe(`${sepYear}-09-09T15:00:00.000Z`); // JST Sep 10 00:00 = prev-day 15:00Z
    expect(endUtc).toBe(`${sepYear}-09-10T15:00:00Z`); // JST Sep 11 00:00 = Sep 10 15:00Z
  });
});

describe('jstDayWindowUtc', () => {
  test('July date: bounds cover the full JST calendar day', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    const w = jstDayWindowUtc('2026-07-10');
    expect(w.startUtc).toBe('2026-07-09T15:00:00.000Z');
    expect(w.endUtc).toBe('2026-07-10T15:00:00Z');
  });

  test('September/November dates are not corrupted', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    expect(jstDayWindowUtc('2026-09-10').startUtc).toBe('2026-09-09T15:00:00.000Z');
    expect(jstDayWindowUtc('2026-11-09').startUtc).toBe('2026-11-08T15:00:00.000Z');
  });
});
