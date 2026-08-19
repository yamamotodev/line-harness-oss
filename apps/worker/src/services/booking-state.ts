import type { BookingStatus } from './booking-types.js';

export type BookingAction =
  | 'approve'
  | 'reject'
  | 'expire'
  | 'cancel'
  | 'complete'
  | 'no_show';

const TRANSITIONS: Record<BookingStatus, Partial<Record<BookingAction, BookingStatus>>> = {
  // requested からの cancel は「お店の返信を待っている間に、お客様が取り下げる」経路。
  // これが無いと、取り下げたい予約が requested のまま残り、ジョブA が後から approve して
  // HPB の枠を押さえてしまう。cancelled は終端なので後戻りはできない。
  requested: { approve: 'confirmed', reject: 'rejected', expire: 'expired', cancel: 'cancelled' },
  confirmed: { cancel: 'cancelled', no_show: 'no_show', complete: 'completed' },
  rejected: {},
  expired: {},
  cancelled: {},
  completed: {},
  no_show: {},
};

export function canTransition(from: BookingStatus, action: BookingAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

export function nextStatus(from: BookingStatus, action: BookingAction): BookingStatus {
  const next = TRANSITIONS[from][action];
  if (!next) {
    throw new Error(`Invalid transition: ${from} via ${action}`);
  }
  return next;
}

export function transitionsFrom(from: BookingStatus): BookingAction[] {
  return Object.keys(TRANSITIONS[from]) as BookingAction[];
}
