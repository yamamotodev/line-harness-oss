import { describe, expect, test, vi } from 'vitest';
import { processDueReminders } from './booking-reminders.js';

interface DueRow {
  id: string;
  booking_id: string;
  kind: 'day_before' | 'hours_before';
  retry_count: number;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  line_user_id: string;
}

const CLAIM_SQL = 'SET retry_count = retry_count + 1';

// claimWins=false は「他の cron 実行に先に claim された」状況を再現する
function stubDB(due: DueRow[], opts: { claimWins?: boolean } = {}) {
  const claimWins = opts.claimWins ?? true;
  const updates: Array<{ sql: string; bound: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          if (sql.includes('FROM booking_reminders')) {
            return { results: due };
          }
          return { results: [] };
        },
        async run() {
          updates.push({ sql, bound });
          if (sql.includes(CLAIM_SQL)) {
            return { success: true, meta: { changes: claimWins ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, updates };
}

const REMINDER_HOURS_BEFORE = 2;
const NOW = new Date('2026-05-10T05:01:00Z');

function dueRow(over: Partial<DueRow> = {}): DueRow {
  return {
    id: 'R1',
    booking_id: 'B1',
    kind: 'day_before',
    retry_count: 0,
    starts_at: '2026-05-10T05:00:00Z',
    menu_name: 'カット',
    staff_name: '山田',
    channel_access_token: 'tok',
    line_user_id: 'U_xyz',
    ...over,
  };
}

describe('processDueReminders', () => {
  test('due な reminder を sent にし sender を呼ぶ', async () => {
    const { db, updates } = stubDB([dueRow()]);
    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        channelAccessToken: 'tok',
        toLineUserId: 'U_xyz',
        kind: 'day_before',
      }),
    );
    expect(updates.find((u) => u.sql.includes("status='sent'"))).toBeTruthy();
  });

  test('送信の前に claim（条件付き UPDATE）を打つ', async () => {
    const { db, updates } = stubDB([dueRow({ retry_count: 1 })]);
    const sender = vi.fn().mockResolvedValue(undefined);
    await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    const claim = updates.find((u) => u.sql.includes(CLAIM_SQL));
    expect(claim).toBeTruthy();
    expect(claim!.sql).toContain("status IN ('pending','failed')");
    expect(claim!.bound).toEqual(['R1', 1]); // (id, 読んだ時点の retry_count)
    // claim が sent 更新より先であること
    expect(updates.indexOf(claim!)).toBeLessThan(
      updates.findIndex((u) => u.sql.includes("status='sent'")),
    );
  });

  test('claim に負けた行（changes=0）は送信しない', async () => {
    const { db, updates } = stubDB([dueRow()], { claimWins: false });
    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sender).not.toHaveBeenCalled();
    expect(updates.filter((u) => u.sql.includes('SET status'))).toHaveLength(0);
  });

  test('同じ行を2つの実行が同時に拾っても送信は1回だけ（重複送信の回帰テスト）', async () => {
    // CAS を実際に持つ共有 DB。2つの cron 実行が同じ行を SELECT した状況を再現する
    const rows = [{ ...dueRow(), status: 'pending' as string, sent_at: null as string | null }];
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            bound = args;
            return stmt;
          },
          async all() {
            if (sql.includes('FROM booking_reminders')) {
              // 実 DB と同じく、SELECT はその時点のスナップショット（コピー）を返す
              return {
                results: rows
                  .filter((r) => r.status === 'pending' || r.status === 'failed')
                  .map((r) => ({ ...r })),
              };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes(CLAIM_SQL)) {
              const [id, expected] = bound as [string, number];
              const r = rows.find((x) => x.id === id);
              if (!r || r.retry_count !== expected) return { success: true, meta: { changes: 0 } };
              if (r.status !== 'pending' && r.status !== 'failed') {
                return { success: true, meta: { changes: 0 } };
              }
              r.retry_count = expected + 1;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("status='sent'")) {
              const [sentAt, id] = bound as [string, string];
              const r = rows.find((x) => x.id === id);
              if (r) {
                r.status = 'sent';
                r.sent_at = sentAt;
              }
            }
            return { success: true, meta: { changes: 1 } };
          },
          async first() {
            return null;
          },
        };
        return stmt;
      },
    } as unknown as D1Database;

    const sender = vi.fn().mockResolvedValue(undefined);
    const params = { now: NOW, sender, reminderHoursBefore: REMINDER_HOURS_BEFORE };
    const [a, b] = await Promise.all([
      processDueReminders(db, params),
      processDueReminders(db, params),
    ]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(rows[0].status).toBe('sent');
  });

  test('未来の reminder は対象外（DB が返さない前提なので空入力）', async () => {
    const { db } = stubDB([]);
    const sender = vi.fn();
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  test('送信失敗 1 回目: status=failed, retry_count=1（claim で加算済み）', async () => {
    const { db, updates } = stubDB([dueRow({ line_user_id: 'U' })]);
    const sender = vi.fn().mockRejectedValue(new Error('LINE 500'));
    const result = await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    expect(result).toEqual({ sent: 0, failed: 1 });
    const claim = updates.find((u) => u.sql.includes(CLAIM_SQL));
    expect(claim!.bound).toEqual(['R1', 0]); // 0 → 1 に加算される
    const failedUpdate = updates.find((u) => u.sql.includes('UPDATE booking_reminders SET status ='));
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate!.bound[0]).toBe('failed');
    expect(failedUpdate!.bound[1]).toBe('LINE 500'); // last_error
  });

  test('送信失敗 3 回目: failed_permanent', async () => {
    const { db, updates } = stubDB([
      dueRow({ kind: 'hours_before', retry_count: 2, line_user_id: 'U' }), // 3回目
    ]);
    const sender = vi.fn().mockRejectedValue(new Error('LINE 500'));
    await processDueReminders(db, {
      now: NOW,
      sender,
      reminderHoursBefore: REMINDER_HOURS_BEFORE,
    });
    const u = updates.find((x) => x.sql.includes('UPDATE booking_reminders SET status ='));
    expect(u!.bound[0]).toBe('failed_permanent');
  });
});
