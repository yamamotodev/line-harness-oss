import { describe, expect, test } from 'vitest';
import { canTransition, nextStatus, transitionsFrom, type BookingAction } from './booking-state.js';

describe('canTransition', () => {
  test('requested → confirmed via approve', () => {
    expect(canTransition('requested', 'approve')).toBe(true);
  });
  test('requested → rejected via reject', () => {
    expect(canTransition('requested', 'reject')).toBe(true);
  });
  test('requested → expired via expire', () => {
    expect(canTransition('requested', 'expire')).toBe(true);
  });
  // 返信待ちの間にお客様が取り下げる経路。無いと requested のまま残り、
  // ジョブA が後から approve して HPB の枠を押さえてしまう。
  test('requested → cancelled via cancel', () => {
    expect(canTransition('requested', 'cancel')).toBe(true);
    expect(nextStatus('requested', 'cancel')).toBe('cancelled');
  });
  test('confirmed → cancelled via cancel', () => {
    expect(canTransition('confirmed', 'cancel')).toBe(true);
  });
  test('confirmed → no_show via no_show', () => {
    expect(canTransition('confirmed', 'no_show')).toBe(true);
  });
  test('confirmed → completed via complete', () => {
    expect(canTransition('confirmed', 'complete')).toBe(true);
  });
  test('rejected → confirmed: forbidden', () => {
    expect(canTransition('rejected', 'approve')).toBe(false);
  });
  test('completed → cancelled: forbidden', () => {
    expect(canTransition('completed', 'cancel')).toBe(false);
  });
  test('expired → confirmed: forbidden', () => {
    expect(canTransition('expired', 'approve')).toBe(false);
  });
  test('cancelled is terminal', () => {
    expect(canTransition('cancelled', 'approve')).toBe(false);
    expect(canTransition('cancelled', 'cancel')).toBe(false);
  });
});

describe('nextStatus', () => {
  test('returns correct next state for valid transition', () => {
    expect(nextStatus('requested', 'approve')).toBe('confirmed');
    expect(nextStatus('confirmed', 'cancel')).toBe('cancelled');
  });
  test('throws for invalid transition', () => {
    expect(() => nextStatus('rejected', 'approve')).toThrow(/Invalid transition/);
  });
});

describe('transitionsFrom', () => {
  test('requested allows approve / reject / expire / cancel', () => {
    const actions: BookingAction[] = transitionsFrom('requested');
    expect(actions.sort()).toEqual(['approve', 'cancel', 'expire', 'reject']);
  });
  test('confirmed allows cancel / complete / no_show', () => {
    const actions = transitionsFrom('confirmed');
    expect(actions.sort()).toEqual(['cancel', 'complete', 'no_show']);
  });
  test('terminal states return empty array', () => {
    expect(transitionsFrom('rejected')).toEqual([]);
    expect(transitionsFrom('expired')).toEqual([]);
    expect(transitionsFrom('cancelled')).toEqual([]);
    expect(transitionsFrom('completed')).toEqual([]);
    expect(transitionsFrom('no_show')).toEqual([]);
  });
});
