// 空き計算の設備(resource)条件。
//
// availability.golden.test.ts が「設備を使わなければ挙動が変わらないこと」を
// 固定しているのに対し、こちらは「設備を使えば実際に塞がること」を固定する。
//
// 🔑 片方だけでは足りない。ゴールデン不変は「壊していない証明」であって
//    「できるようになった証明」ではない。設備条件を実装し忘れてもゴールデンは
//    通ってしまうので、この2本を対で置く。

import { describe, expect, test } from 'vitest';
import { getAvailability } from './availability.js';

interface StubData {
  menu?: { duration_minutes: number; buffer_after_minutes: number; override_duration: number | null };
  staff?: Array<{ id: string; display_name: string; is_designation_optional: number }>;
  shifts?: Array<{ staff_id: string; work_date: string; start_time: string; end_time: string }>;
  bookings?: Array<{ staff_id: string; starts_at: string; block_ends_at: string }>;
  /** このメニューが使う設備 */
  menuResources?: string[];
  /** その設備が埋まっている時間帯 */
  resourceBookings?: Array<{ starts_at: string; block_ends_at: string }>;
}

function stubDB(data: StubData): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('FROM menus')) return data.menu ?? null;
          return null;
        },
        async all() {
          // ⚠️ 'resource_id IN' を 'FROM bookings' より先に見る。
          //    設備の予約クエリも FROM bookings なので、順番を逆にすると
          //    スタッフの予約が設備の予約として混ざる。
          if (sql.includes('FROM menu_resources')) {
            return { results: (data.menuResources ?? []).map((id) => ({ resource_id: id })) };
          }
          if (sql.includes('resource_id IN')) {
            return { results: data.resourceBookings ?? [] };
          }
          if (sql.includes('FROM staff') && sql.includes('staff_menus')) {
            return { results: data.staff ?? [] };
          }
          if (sql.includes('FROM staff_shifts')) {
            return { results: data.shifts ?? [] };
          }
          if (sql.includes('FROM bookings')) {
            return { results: data.bookings ?? [] };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

const MENU_60 = { duration_minutes: 60, buffer_after_minutes: 0, override_duration: null };
const S1 = { id: 'S1', display_name: '山田', is_designation_optional: 0 };
const S2 = { id: 'S2', display_name: '佐藤', is_designation_optional: 0 };
const SHIFT = (staffId: string) => ({
  staff_id: staffId,
  work_date: '2026-05-09',
  start_time: '10:00',
  end_time: '13:00',
});

function run(data: StubData) {
  return getAvailability(stubDB(data), {
    lineAccountId: 'A1',
    menuId: 'M1',
    from: '2026-05-09',
    to: '2026-05-09',
    now: new Date('2026-05-08T00:00:00Z'),
    minLeadTimeMinutes: 60,
  });
}

describe('空き計算の設備条件', () => {
  test('設備を使わないメニュー（美容室）は今までどおり', async () => {
    const r = await run({ menu: MENU_60, staff: [S1], shifts: [SHIFT('S1')] });
    expect(r.by_staff[0].slots.map((s) => s.start)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  test('設備を使うが、その設備に予約が無ければ今までどおり', async () => {
    const r = await run({
      menu: MENU_60,
      staff: [S1],
      shifts: [SHIFT('S1')],
      menuResources: ['bed1'],
      resourceBookings: [],
    });
    expect(r.by_staff[0].slots.map((s) => s.start)).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00']);
  });

  test('🔴 スタッフが空いていても、設備が塞がっている時間帯は枠を出さない', async () => {
    const r = await run({
      menu: MENU_60,
      staff: [S1],
      shifts: [SHIFT('S1')],
      // スタッフ側の予約は無い＝staff だけ見ていたら全枠出てしまう
      bookings: [],
      menuResources: ['bed1'],
      // ベッドが 11:00-12:00 JST (02:00-03:00 UTC) で埋まっている
      resourceBookings: [{ starts_at: '2026-05-09T02:00:00Z', block_ends_at: '2026-05-09T03:00:00Z' }],
    });
    // 11:00 と 11:30 開始は設備とぶつかるので消える
    expect(r.by_staff[0].slots.map((s) => s.start)).toEqual(['10:00', '12:00']);
  });

  test('🔴 設備の埋まりは全スタッフに効く（ベッドが1台なら誰が担当でも塞がる）', async () => {
    const r = await run({
      menu: MENU_60,
      staff: [S1, S2],
      shifts: [SHIFT('S1'), SHIFT('S2')],
      menuResources: ['bed1'],
      resourceBookings: [{ starts_at: '2026-05-09T02:00:00Z', block_ends_at: '2026-05-09T03:00:00Z' }],
    });
    for (const staff of r.by_staff) {
      expect(staff.slots.map((s) => s.start)).toEqual(['10:00', '12:00']);
    }
  });

  test('スタッフの予約と設備の予約は両方効く（AND 条件）', async () => {
    const r = await run({
      menu: MENU_60,
      staff: [S1],
      shifts: [SHIFT('S1')],
      // スタッフが 10:00-11:00 JST で埋まっている
      bookings: [{ staff_id: 'S1', starts_at: '2026-05-09T01:00:00Z', block_ends_at: '2026-05-09T02:00:00Z' }],
      menuResources: ['bed1'],
      // 設備が 11:00-12:00 JST で埋まっている
      resourceBookings: [{ starts_at: '2026-05-09T02:00:00Z', block_ends_at: '2026-05-09T03:00:00Z' }],
    });
    // 残るのは 12:00 だけ
    expect(r.by_staff[0].slots.map((s) => s.start)).toEqual(['12:00']);
  });

  test('設備が複数あってもそれぞれの埋まりが効く', async () => {
    const r = await run({
      menu: MENU_60,
      staff: [S1],
      shifts: [SHIFT('S1')],
      menuResources: ['bed1', 'machine1'],
      resourceBookings: [
        { starts_at: '2026-05-09T01:00:00Z', block_ends_at: '2026-05-09T02:00:00Z' }, // 10:00-11:00
        { starts_at: '2026-05-09T02:00:00Z', block_ends_at: '2026-05-09T03:00:00Z' }, // 11:00-12:00
      ],
    });
    expect(r.by_staff[0].slots.map((s) => s.start)).toEqual(['12:00']);
  });
});
