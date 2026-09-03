// LIFF 予約ルート（/api/liff/booking/*）のテスト足場。
//
// 🔴 このファイルが存在しなかった。booking-admin.test.ts しか無く、
//    LIFF の空き表示と予約確定は1件も検証されていなかった。
//    cdb3cfb が入れた business_unit の fail-closed も、LIFF 側は無検証のまま
//    だった（管理画面側は e8e37fb で塞いだ）。ここで両方を埋める。
//
// このコミット（Step 2-3）では **既存の挙動だけ** を固定する。gate の結線は 2-4。
// 足場と結線を同じコミットに混ぜると、落ちた時にどちらが原因か切り分けられない。

import { describe, expect, test, vi, beforeEach } from 'vitest';
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

const idempotencyMocks = {
  findIdempotencyResponse: vi.fn(async () => null as null | { status: number; body: unknown }),
  saveIdempotencyResponse: vi.fn(async () => undefined),
};
vi.mock('../services/booking-idempotency.js', () => idempotencyMocks);

vi.mock('../services/booking-notifier.js', () => ({ sendBookingNotification: vi.fn() }));
vi.mock('../services/friend-tag-attach.js', () => ({
  attachTagAndFireSideEffects: vi.fn(async () => undefined),
}));

// 予約可否の関門(gate)。既定は「通す」。
// 🔑 gate の判定そのものは packages/db/test/booking-gate.test.ts が本物のSQLiteで
//    検証している。ここで検証するのは「ルートが gate を呼び、その答えに従うか」だけ。
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
  return {
    ...actual,
    getLineAccounts: vi.fn(async () => [
      { id: 'acc1', channel_id: 'ch1', login_channel_id: 'ch1', liff_id: 'ch1-abc' },
    ]),
    getReservability: gateMocks.getReservability,
  };
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

function makeApp(db: unknown) {
  const app = new Hono();
  app.route('/', booking);
  return { app, env: { DB: db, LINE_LOGIN_CHANNEL_ID: 'ch1' } };
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

type Handler = {
  first?: unknown;
  all?: { results: unknown[] };
  run?: { meta: { changes: number } };
};

// SQL 断片マッチで応答を返す scripted D1。マッチしない SQL は空応答。
// 断片は「先に書いた方が勝つ」ので、狭いものから並べる。
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

// LINE の id_token 検証は必ず成功させる（認証は本テストの対象外）。
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ sub: 'U1' }), { status: 200 })),
  );
  idempotencyMocks.findIdempotencyResponse.mockResolvedValue(null);
  availabilityMocks.computeSlots.mockReturnValue([]);
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

const AUTH = { Authorization: 'Bearer dummy-id-token', 'Content-Type': 'application/json' };
const IDEM = { 'Idempotency-Key': 'idem-1' };

// 常に7日後の 02:00Z（= JST 11:00、モックしたシフト 10:00-19:00 の中）。
// 固定日付にすると、カレンダーが追いつくたびに 422 で落ちる時限爆弾になる。
const futureStartsAt = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(2, 0, 0, 0);
  return d.toISOString();
})();

const validBody = { menu_id: 'm1', staff_id: 's1', starts_at: futureStartsAt };

function happyDb(insertChanges = 1, businessUnits: unknown[] = [{ id: 'bu_acc1' }]) {
  return scriptedDb([
    ['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }],
    ['SELECT id FROM friends', { first: { id: 'f1' } }],
    ['SELECT is_following FROM friends', { first: { is_following: 1 } }],
    [
      'FROM menus m',
      {
        first: {
          duration_minutes: 60,
          buffer_after_minutes: 10,
          dur: 60,
          price: 8000,
          is_offered: 1,
          auto_tag_id: null,
        },
      },
    ],
    ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
    ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
    // 予約は必ず business_unit に属する（migration 050 / cdb3cfb）。
    ['FROM business_units', { all: { results: businessUnits } }],
    ['INSERT INTO bookings', { run: { meta: { changes: insertChanges } } }],
    ['INSERT INTO booking_reminders', { run: { meta: { changes: 1 } } }],
  ]);
}

function post(db: unknown, body: unknown = validBody, headers: Record<string, string> = { ...AUTH, ...IDEM }) {
  const { app, env } = makeApp(db);
  return app.request(
    '/api/liff/booking/requests?liffId=ch1-abc',
    { method: 'POST', body: JSON.stringify(body), headers },
    env,
    execCtx,
  );
}

// ================================================================
// GET /api/liff/booking/availability
// ================================================================

describe('GET /api/liff/booking/availability', () => {
  test('404 without liffId', async () => {
    const { app, env } = makeApp(scriptedDb([]));
    const res = await app.request('/api/liff/booking/availability', {}, env);
    expect(res.status).toBe(404);
  });

  test('400 without params', async () => {
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    const res = await app.request('/api/liff/booking/availability?liffId=ch1-abc', {}, env);
    expect(res.status).toBe(400);
  });

  test('400 when range wider than 28 days', async () => {
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/liff/booking/availability?liffId=ch1-abc&menu_id=m1&from=2026-07-01&to=2026-08-15',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  test('200 delegates to getAvailability with the customer lead time (60分)', async () => {
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/liff/booking/availability?liffId=ch1-abc&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    // 管理画面(minLeadTimeMinutes: 0)と違い、客側はリードタイムが効く
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', menuId: 'm1', minLeadTimeMinutes: 60 }),
    );
  });

  // 🔴 表示側の gate。ここを閉じないと、客が画面を見て予約を入れる。

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
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/liff/booking/availability?liffId=ch1-abc&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      by_staff: { slots: unknown[] }[];
      gate: { reservable: boolean; blocked_staff: Record<string, unknown>[] };
    };
    expect(body.by_staff[0].slots).toEqual([]);
    // 🔑 空欄で終わらせない。理由が無いと「空きが無い」と読まれる
    expect(body.gate.reservable).toBe(false);
    expect(body.gate.blocked_staff[0]).toMatchObject({
      staff_id: 's1',
      reason: 'stale',
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
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/liff/booking/availability?liffId=ch1-abc&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    const body = (await res.json()) as { by_staff: { slots: { date: string }[] }[] };
    expect(body.by_staff[0].slots.map((s) => s.date)).toEqual(['2026-07-08']);
  });

  test('🔴 B: gate をスタッフごとに呼んでいる（店舗単位で1回ではない）', async () => {
    availabilityMocks.getAvailability.mockResolvedValue({
      by_staff: [
        { staff_id: 's1', display_name: 'A', slots: [] },
        { staff_id: 's2', display_name: 'B', slots: [] },
      ],
    });
    const db = scriptedDb([['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }]]);
    const { app, env } = makeApp(db);
    await app.request(
      '/api/liff/booking/availability?liffId=ch1-abc&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(gateMocks.getReservability).toHaveBeenCalledTimes(2);
    for (const staffId of ['s1', 's2']) {
      expect(gateMocks.getReservability).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lineAccountId: 'acc1', staffId, date: '2026-07-08' }),
      );
    }
  });
});

// ================================================================
// POST /api/liff/booking/requests
// ================================================================

describe('POST /api/liff/booking/requests', () => {
  test('404 unknown_liff', async () => {
    const { app, env } = makeApp(scriptedDb([]));
    const res = await app.request(
      '/api/liff/booking/requests?liffId=nope',
      { method: 'POST', body: JSON.stringify(validBody), headers: { ...AUTH, ...IDEM } },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
  });

  test('400 without Idempotency-Key', async () => {
    const res = await post(happyDb(), validBody, AUTH);
    expect(res.status).toBe(400);
  });

  test('401 without Authorization', async () => {
    const res = await post(happyDb(), validBody, { ...IDEM, 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
  });

  test('404 friend_not_found', async () => {
    const db = scriptedDb([
      ['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }],
      ['SELECT id FROM friends', { first: null }],
    ]);
    const res = await post(db);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('friend_not_found');
  });

  test('403 cannot_book when the friend has unfollowed', async () => {
    const db = scriptedDb([
      ['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }],
      ['SELECT id FROM friends', { first: { id: 'f1' } }],
      ['SELECT is_following FROM friends', { first: { is_following: 0 } }],
    ]);
    const res = await post(db);
    expect(res.status).toBe(403);
  });

  test('422 menu_not_offered', async () => {
    const db = scriptedDb([
      ['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }],
      ['SELECT id FROM friends', { first: { id: 'f1' } }],
      ['SELECT is_following FROM friends', { first: { is_following: 1 } }],
      ['FROM menus m', { first: { dur: 60, buffer_after_minutes: 0, is_offered: 0 } }],
    ]);
    const res = await post(db);
    expect(res.status).toBe(422);
  });

  test('422 past_datetime', async () => {
    const res = await post(happyDb(), { ...validBody, starts_at: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(422);
  });

  test('422 out_of_shift', async () => {
    const db = scriptedDb([
      ['FROM line_accounts WHERE liff_id', { first: { id: 'acc1' } }],
      ['SELECT id FROM friends', { first: { id: 'f1' } }],
      ['SELECT is_following FROM friends', { first: { is_following: 1 } }],
      ['FROM menus m', { first: { dur: 60, buffer_after_minutes: 10, is_offered: 1, auto_tag_id: null } }],
      ['FROM staff_shifts', { first: null }],
    ]);
    const res = await post(db);
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('out_of_shift');
  });

  test('422 slot_not_available', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '14:00', end: '15:00' }]);
    const res = await post(happyDb());
    expect(res.status).toBe(422);
  });

  test('201 creates a requested booking', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const res = await post(db);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking_id: string; status: string };
    // 🔑 LIFF は 'requested'（承認待ち）。管理画面の 'confirmed' と違う
    expect(body.status).toBe('requested');
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('requested');
    expect(insert?.params).toContain('bu_acc1');
  });

  test('409 on slot conflict (atomic insert 0 rows)', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const res = await post(happyDb(0));
    expect(res.status).toBe(409);
  });

  test('同じ Idempotency-Key はキャッシュを返し、予約を作らない', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    idempotencyMocks.findIdempotencyResponse.mockResolvedValue({
      status: 201,
      body: { booking_id: 'cached', status: 'requested' },
    });
    const db = happyDb();
    const res = await post(db);
    expect(res.status).toBe(201);
    expect((await res.json() as { booking_id: string }).booking_id).toBe('cached');
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  // --------------------------------------------------------------
  // 🔴 gate（ガードが効く側）— ミューテーションテスト
  //
  // 検証したいのはステータスコードではなく「予約が1件も作られないこと」。
  // INSERT のモックは changes:1 を返したままなので、gate を無視すれば 201 に
  // なって落ちる。A(挙動) と B(結線) を対で置く。

  test('🔴 A: gate が閉じたら 503・予約を作らない（no_business_unit）', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    gateMocks.getReservability.mockResolvedValue(blockedGate('no_business_unit'));
    const db = happyDb();
    const res = await post(db);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'booking_unavailable', reason: 'no_business_unit' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('🔴 A: gate が閉じたら 503・予約を作らない（stale＝同期が止まっている）', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    gateMocks.getReservability.mockResolvedValue(blockedGate('stale'));
    const db = happyDb();
    const res = await post(db);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'booking_unavailable', reason: 'stale' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('🔴 B: gate を、その予約のスタッフと日付で呼んでいる', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    await post(happyDb());
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
    await post(db);
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('bu_from_gate');
  });
});
