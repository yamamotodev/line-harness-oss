// 販売上限を D1 から決める部分の回帰テスト。
//
// 🔴 このファイルが守っているのは1点だけ:「コードが日数を持たないこと」。
//    定数 14 に戻ると、同期は 365 日分やるのに完了判定は 14 日分で ready と
//    言い、15〜365 日目が未同期のまま売られる。

import { describe, expect, test } from 'vitest';
import {
  BOOKING_HORIZON_FALLBACK_DAYS,
  getBookingHorizonDays,
  parseHorizonDays,
  resolveSalesHorizon,
} from './booking-horizon.js';

interface StubData {
  /** account_settings.value の生の中身。undefined = 行が無い */
  settingValue?: string;
  /** staff_shifts の最終日 */
  lastShiftDate?: string | null;
}

function stubDB(data: StubData): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('FROM account_settings')) {
            return data.settingValue === undefined ? null : { value: data.settingValue };
          }
          if (sql.includes('FROM staff_shifts')) {
            return { last_shift_date: data.lastShiftDate ?? null };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

const NOW = new Date('2026-09-23T00:00:00+09:00'); // JST の 2026-09-23

describe('parseHorizonDays', () => {
  test('素の数値文字列を読む（D1 の実物は "365"）', () => {
    expect(parseHorizonDays('365')).toBe(365);
  });

  test('行が無ければ 365。🔴 90 ではない', () => {
    expect(parseHorizonDays(null)).toBe(365);
    expect(BOOKING_HORIZON_FALLBACK_DAYS).toBe(365);
  });

  test('JSON でくるまれた値も読む（setAccountSetting はこの形で書く）', () => {
    expect(parseHorizonDays('"365"')).toBe(365);
    expect(parseHorizonDays('365.0')).toBe(365);
  });

  test('0・負数・空・数値でないものはフォールバック', () => {
    expect(parseHorizonDays('0')).toBe(365);
    expect(parseHorizonDays('-5')).toBe(365);
    expect(parseHorizonDays('')).toBe(365);
    expect(parseHorizonDays('abc')).toBe(365);
  });

  test('小数は切り捨てる', () => {
    expect(parseHorizonDays('90.7')).toBe(90);
  });
});

describe('getBookingHorizonDays', () => {
  test('D1 の値を使う（コードの定数を使わない）', async () => {
    await expect(getBookingHorizonDays(stubDB({ settingValue: '365' }), 'acct')).resolves.toBe(365);
    await expect(getBookingHorizonDays(stubDB({ settingValue: '90' }), 'acct')).resolves.toBe(90);
  });

  test('行が無ければ 365', async () => {
    await expect(getBookingHorizonDays(stubDB({}), 'acct')).resolves.toBe(365);
  });
});

describe('resolveSalesHorizon', () => {
  test('シフト最終日が手前なら、そこが販売上限', async () => {
    const db = stubDB({ settingValue: '365', lastShiftDate: '2026-11-09' });
    const h = await resolveSalesHorizon(db, { lineAccountId: 'acct', now: NOW });
    expect(h).toEqual({
      horizonDate: '2026-11-09',
      lastShiftDate: '2026-11-09',
      capDays: 365,
      capDate: '2027-09-23',
      limitedBy: 'shift',
    });
  });

  test('シフトがキャップより先まで入っていれば、キャップが販売上限', async () => {
    const db = stubDB({ settingValue: '365', lastShiftDate: '2029-04-01' });
    const h = await resolveSalesHorizon(db, { lineAccountId: 'acct', now: NOW });
    expect(h.horizonDate).toBe('2027-09-23');
    expect(h.limitedBy).toBe('cap');
  });

  test('同着はシフト側（poc2 の resolveHorizon と同じ）', async () => {
    const db = stubDB({ settingValue: '365', lastShiftDate: '2027-09-23' });
    const h = await resolveSalesHorizon(db, { lineAccountId: 'acct', now: NOW });
    expect(h.horizonDate).toBe('2027-09-23');
    expect(h.limitedBy).toBe('shift');
  });

  test('シフトが1件も無ければ販売上限は無い（null）', async () => {
    const db = stubDB({ settingValue: '365', lastShiftDate: null });
    const h = await resolveSalesHorizon(db, { lineAccountId: 'acct', now: NOW });
    expect(h.horizonDate).toBeNull();
    expect(h.lastShiftDate).toBeNull();
    expect(h.limitedBy).toBeNull();
    expect(h.capDays).toBe(365);
  });

  test('🔴 設定が無くても 14 日には落ちない（廃止した定数への回帰検出）', async () => {
    const db = stubDB({ lastShiftDate: '2027-01-01' });
    const h = await resolveSalesHorizon(db, { lineAccountId: 'acct', now: NOW });
    expect(h.capDays).toBe(365);
    expect(h.capDate).toBe('2027-09-23');
    expect(h.horizonDate).toBe('2027-01-01'); // 14 日なら 2026-10-07 で切られていた
  });
});
