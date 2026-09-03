// 空き計算のゴールデンテスト（characterization test / golden master）
//
// 🔴 このファイルの目的は「今の getAvailability の出力を丸ごと石に刻むこと」。
//    正しさを主張するテストではない。**現状を固定する**テスト。
//
// なぜ要るか:
//   Step 2-5 で空き計算を「staff が空き」から「staff が空き かつ resource も空き」
//   に書き換える。美容室では resource が1件も無いので挙動は変わらないはずだが、
//   「はず」を人の目で確かめるのは無理（スロット生成はシフト・バッファ・
//   リードタイム・JST変換が絡む）。
//   → 実装を触る**前**にこのスナップショットを確定させ、触った**後**に
//     1文字も変わらないことを機械で示す。git の差分に「実装は変わったが
//     ゴールデンは無変更」が残るので、後から誰でも再現できる。
//
// 🔑 stubDB は認識できない SQL に必ず空を返す。Step 2-5 で設備用のクエリが
//    増えても、このファイルは1文字も変えずに通らなければならない
//    （＝設備0件＝美容室の状態を再現していることになる）。
//    **このファイルを 2-5 で編集したくなったら、それは挙動が変わった合図。**

import { describe, expect, test } from 'vitest';
import { getAvailability } from './availability.js';

interface StubData {
  menu?: {
    duration_minutes: number;
    buffer_after_minutes: number;
    override_duration: number | null;
    override_price: number | null;
  };
  staff?: Array<{ id: string; display_name: string; is_designation_optional: number }>;
  shifts?: Array<{ staff_id: string; work_date: string; start_time: string; end_time: string }>;
  bookings?: Array<{ staff_id: string; starts_at: string; block_ends_at: string }>;
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
          if (sql.includes('FROM staff') && sql.includes('staff_menus')) {
            return { results: data.staff ?? [] };
          }
          if (sql.includes('FROM staff_shifts')) {
            return { results: data.shifts ?? [] };
          }
          if (sql.includes('FROM bookings')) {
            return { results: data.bookings ?? [] };
          }
          // 🔴 認識できないクエリ（＝ Step 2-5 で増える設備まわり）は必ず空。
          return { results: [] };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

const MENU_60 = {
  duration_minutes: 60,
  buffer_after_minutes: 0,
  override_duration: null,
  override_price: null,
};
const S1 = { id: 'S1', display_name: '山田', is_designation_optional: 0 };
const S2 = { id: 'S2', display_name: '佐藤', is_designation_optional: 1 };

interface Scenario {
  name: string;
  data: StubData;
  params: {
    staffId?: string;
    from: string;
    to: string;
    now: string;
    minLeadTimeMinutes: number;
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: '01 基本 1スタッフ1日 シフト内',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '02 バッファあり（施術60+バッファ15で占有75分）',
    data: {
      menu: { ...MENU_60, buffer_after_minutes: 15 },
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '03 override_duration がベースより短い',
    data: {
      menu: { ...MENU_60, override_duration: 30 },
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '12:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '04 override_duration がベースより長い',
    data: {
      menu: { ...MENU_60, override_duration: 120 },
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '05 複数スタッフ（指名任意が先に並ぶ）',
    data: {
      menu: MENU_60,
      staff: [S2, S1],
      shifts: [
        { staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '12:00' },
        { staff_id: 'S2', work_date: '2026-05-09', start_time: '13:00', end_time: '15:00' },
      ],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '06 複数日（シフトが飛び飛び・中日は休み）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [
        { staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '12:00' },
        { staff_id: 'S1', work_date: '2026-05-11', start_time: '14:00', end_time: '16:00' },
      ],
    },
    params: { from: '2026-05-09', to: '2026-05-11', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '07 既存予約で分断される',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '15:00' }],
      // 12:00-13:00 JST
      bookings: [{ staff_id: 'S1', starts_at: '2026-05-09T03:00:00Z', block_ends_at: '2026-05-09T04:00:00Z' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '08 満杯（シフト全体が予約で埋まっている）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '12:00' }],
      bookings: [{ staff_id: 'S1', starts_at: '2026-05-09T01:00:00Z', block_ends_at: '2026-05-09T03:00:00Z' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '09 隣接する予約が2件（隙間がちょうど1枠）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '15:00' }],
      bookings: [
        { staff_id: 'S1', starts_at: '2026-05-09T01:00:00Z', block_ends_at: '2026-05-09T02:00:00Z' },
        { staff_id: 'S1', starts_at: '2026-05-09T03:00:00Z', block_ends_at: '2026-05-09T06:00:00Z' },
      ],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '10 リードタイム境界ちょうど',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    // now = 09:00 JST、リードタイム60分 → 10:00 ちょうどが境界
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-09T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '11 リードタイム境界の1分後（先頭が落ちる）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-09T00:01:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '12 リードタイム 0（管理画面の電話予約）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-09T00:59:00Z', minLeadTimeMinutes: 0 },
  },
  {
    name: '13 JST 日跨ぎ（UTC では前日の予約が JST 当日を塞ぐ）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
      // 2026-05-09 10:00-11:00 JST = 2026-05-09T01:00Z（UTCでは同日だが、境界の確認用に
      // UTC 前日側の予約も入れる）
      bookings: [
        { staff_id: 'S1', starts_at: '2026-05-08T15:00:00Z', block_ends_at: '2026-05-09T01:00:00Z' },
      ],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '14 端数シフト 10:15-12:45（粒度30分の丸め）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:15', end_time: '12:45' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '15 メニューがシフトより長い（1枠も出ない）',
    data: {
      menu: { ...MENU_60, duration_minutes: 240 },
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '12:00' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '16 staff_id 指定',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
    },
    params: { staffId: 'S1', from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '17 メニューが見つからない',
    data: {},
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '18 スタッフ0件',
    data: { menu: MENU_60, staff: [] },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '19 シフトが1日も無い',
    data: { menu: MENU_60, staff: [S1], shifts: [] },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '20 範囲外の予約は影響しない',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '13:00' }],
      bookings: [{ staff_id: 'S1', starts_at: '2026-06-01T01:00:00Z', block_ends_at: '2026-06-01T02:00:00Z' }],
    },
    params: { from: '2026-05-09', to: '2026-05-09', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '21 9月（月名の文字列置換バグの回帰枠）',
    data: {
      menu: MENU_60,
      staff: [S1],
      shifts: [{ staff_id: 'S1', work_date: '2026-09-10', start_time: '10:00', end_time: '13:00' }],
      bookings: [{ staff_id: 'S1', starts_at: '2026-09-10T02:00:00Z', block_ends_at: '2026-09-10T03:00:00Z' }],
    },
    params: { from: '2026-09-10', to: '2026-09-10', now: '2026-09-01T00:00:00Z', minLeadTimeMinutes: 60 },
  },
  {
    name: '22 複数スタッフ×複数日×予約あり（総合）',
    data: {
      menu: { ...MENU_60, buffer_after_minutes: 10 },
      staff: [S1, S2],
      shifts: [
        { staff_id: 'S1', work_date: '2026-05-09', start_time: '10:00', end_time: '14:00' },
        { staff_id: 'S1', work_date: '2026-05-10', start_time: '10:00', end_time: '12:00' },
        { staff_id: 'S2', work_date: '2026-05-10', start_time: '11:00', end_time: '16:00' },
      ],
      bookings: [
        { staff_id: 'S1', starts_at: '2026-05-09T02:00:00Z', block_ends_at: '2026-05-09T03:10:00Z' },
        { staff_id: 'S2', starts_at: '2026-05-10T04:00:00Z', block_ends_at: '2026-05-10T05:10:00Z' },
      ],
    },
    params: { from: '2026-05-09', to: '2026-05-10', now: '2026-05-08T00:00:00Z', minLeadTimeMinutes: 60 },
  },
];

describe('getAvailability ゴールデン（設備0件＝美容室の状態）', () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      const result = await getAvailability(stubDB(s.data), {
        lineAccountId: 'A1',
        menuId: 'M1',
        staffId: s.params.staffId,
        from: s.params.from,
        to: s.params.to,
        now: new Date(s.params.now),
        minLeadTimeMinutes: s.params.minLeadTimeMinutes,
      });
      expect(result).toMatchSnapshot();
    });
  }
});
