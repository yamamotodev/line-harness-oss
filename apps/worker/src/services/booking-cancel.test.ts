import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  CANCEL_DEADLINE_SETTING_KEY,
  DEFAULT_CANCEL_DEADLINE_HOURS,
  canCancelBooking,
  cancelPendingBookingReminders,
  checkCancelWindow,
  getCancelDeadlineHours,
  parseCancelDeadlineHours,
} from './booking-cancel.js';

const NOW = new Date('2026-05-10T00:00:00.000Z'); // JST 09:00

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCancelDeadlineHours', () => {
  test('未設定は既定値', () => {
    expect(parseCancelDeadlineHours(null)).toBe(DEFAULT_CANCEL_DEADLINE_HOURS);
    expect(parseCancelDeadlineHours(undefined)).toBe(DEFAULT_CANCEL_DEADLINE_HOURS);
  });
  test('数値文字列はそのまま時間数', () => {
    expect(parseCancelDeadlineHours('24')).toBe(24);
    expect(parseCancelDeadlineHours('3')).toBe(3);
    expect(parseCancelDeadlineHours(' 48 ')).toBe(48);
  });
  test('0 は「開始時刻まで可」', () => {
    expect(parseCancelDeadlineHours('0')).toBe(0);
  });
  test('off / 空文字は self キャンセル禁止', () => {
    expect(parseCancelDeadlineHours('off')).toBeNull();
    expect(parseCancelDeadlineHours('OFF')).toBeNull();
    expect(parseCancelDeadlineHours('')).toBeNull();
  });
  test('壊れた値は既定値に倒す（キャンセルできない方が幽霊予約が残るため）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseCancelDeadlineHours('abc')).toBe(DEFAULT_CANCEL_DEADLINE_HOURS);
    expect(parseCancelDeadlineHours('-5')).toBe(DEFAULT_CANCEL_DEADLINE_HOURS);
  });
});

describe('checkCancelWindow', () => {
  test('期限より前ならキャンセル可', () => {
    // 開始は 48 時間後、期限は 24 時間前 → まだ余裕がある
    const r = checkCancelWindow({
      startsAt: '2026-05-12T00:00:00.000Z',
      deadlineHours: 24,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
  test('期限ちょうどは不可（境界は閉じる）', () => {
    const r = checkCancelWindow({
      startsAt: '2026-05-11T00:00:00.000Z', // ちょうど 24 時間後
      deadlineHours: 24,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'cancel_deadline_passed' });
  });
  test('期限を過ぎていたら deadline_passed', () => {
    const r = checkCancelWindow({
      startsAt: '2026-05-10T06:00:00.000Z', // 6 時間後
      deadlineHours: 24,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'cancel_deadline_passed' });
  });
  test('deadlineHours=0 なら開始時刻まで可', () => {
    expect(
      checkCancelWindow({ startsAt: '2026-05-10T00:30:00.000Z', deadlineHours: 0, now: NOW }).ok,
    ).toBe(true);
    expect(
      checkCancelWindow({ startsAt: '2026-05-09T23:59:00.000Z', deadlineHours: 0, now: NOW }),
    ).toEqual({ ok: false, reason: 'cancel_deadline_passed' });
  });
  test('null は not_allowed（403 に割り当てる）', () => {
    const r = checkCancelWindow({
      startsAt: '2026-05-12T00:00:00.000Z',
      deadlineHours: null,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'cancel_not_allowed' });
  });
  test('starts_at が壊れていたら not_allowed（NaN で素通りさせない）', () => {
    const r = checkCancelWindow({ startsAt: 'not-a-date', deadlineHours: 24, now: NOW });
    expect(r).toEqual({ ok: false, reason: 'cancel_not_allowed' });
  });
});

describe('canCancelBooking', () => {
  const base = { startsAt: '2026-05-12T00:00:00.000Z', deadlineHours: 24, now: NOW };
  test('requested / confirmed だけ true', () => {
    expect(canCancelBooking({ ...base, status: 'requested' })).toBe(true);
    expect(canCancelBooking({ ...base, status: 'confirmed' })).toBe(true);
  });
  test('終端状態は false', () => {
    for (const status of ['cancelled', 'rejected', 'expired', 'completed', 'no_show']) {
      expect(canCancelBooking({ ...base, status })).toBe(false);
    }
  });
  test('期限切れなら confirmed でも false（ボタンを出さない）', () => {
    expect(
      canCancelBooking({ ...base, startsAt: '2026-05-10T06:00:00.000Z', status: 'confirmed' }),
    ).toBe(false);
  });
});

// --- D1 の薄いフェイク（account_settings の1行だけ返す） ---
function fakeDb(value: string | null): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => (value == null ? null : { value }),
        run: async () => ({ meta: { changes: 1 } }),
        _sql: sql,
      }),
    }),
  } as unknown as D1Database;
}

describe('getCancelDeadlineHours', () => {
  test('account_settings に行があればその値', async () => {
    expect(await getCancelDeadlineHours(fakeDb('3'), 'acc1')).toBe(3);
  });
  test('行が無ければ既定値', async () => {
    expect(await getCancelDeadlineHours(fakeDb(null), 'acc1')).toBe(
      DEFAULT_CANCEL_DEADLINE_HOURS,
    );
  });
  test('off なら null', async () => {
    expect(await getCancelDeadlineHours(fakeDb('off'), 'acc1')).toBeNull();
  });
});

describe('cancelPendingBookingReminders', () => {
  test('pending のリマインダーだけを cancelled にする SQL を投げる', async () => {
    let seenSql = '';
    const db = {
      prepare: (sql: string) => {
        seenSql = sql;
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      },
    } as unknown as D1Database;
    await cancelPendingBookingReminders(db, 'b1');
    expect(seenSql).toContain("status='cancelled'");
    expect(seenSql).toContain("status = 'pending'");
  });
});

describe('設定キー', () => {
  test('key 名が変わっていないこと（poc2 / 管理画面と共有するため）', () => {
    expect(CANCEL_DEADLINE_SETTING_KEY).toBe('cancel_deadline_hours_before');
  });
});
