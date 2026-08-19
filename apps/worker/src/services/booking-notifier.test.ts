import { describe, expect, test } from 'vitest';
import { renderNotificationText } from './booking-notifier.js';

const ctx = {
  menuName: 'カット',
  staffName: '山田',
  startsAtJst: '2026-05-10 14:00',
  hoursBefore: 2,
};

describe('renderNotificationText', () => {
  test('受付', () => {
    const text = renderNotificationText('requested', ctx);
    expect(text).toContain('予約リクエストを受け付けました');
    expect(text).toContain('カット');
    expect(text).toContain('山田');
    expect(text).toContain('2026-05-10 14:00');
    expect(text).toContain('お店からの返信をお待ちください');
  });
  test('承認', () => {
    const text = renderNotificationText('approved', ctx);
    expect(text).toContain('予約が確定しました');
    // 「お店に連絡してください」ではなく、自分で操作できることを案内する
    expect(text).toContain('予約確認');
    expect(text).toContain('キャンセル');
    expect(text).not.toContain('お店に直接ご連絡ください');
  });
  test('本人キャンセル', () => {
    const text = renderNotificationText('cancelled_by_friend', ctx);
    expect(text).toContain('ご予約をキャンセルしました');
    expect(text).toContain('カット');
    expect(text).toContain('2026-05-10 14:00');
  });
  test('お店都合のキャンセル', () => {
    const text = renderNotificationText('cancelled_by_shop', ctx);
    expect(text).toContain('キャンセルさせていただきました');
    expect(text).toContain('カット');
  });
  test('拒否', () => {
    expect(renderNotificationText('rejected', ctx)).toContain('お取りできませんでした');
  });
  test('期限切れ', () => {
    expect(renderNotificationText('expired', ctx)).toContain('期限切れ');
  });
  test('前日リマインダ', () => {
    expect(renderNotificationText('day_before', ctx)).toContain('明日のご予約');
  });
  test('当日 N 時間前', () => {
    const t = renderNotificationText('hours_before', ctx);
    expect(t).toContain('本日のご予約まであと 2 時間');
  });
});
