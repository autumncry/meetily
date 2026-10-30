import { expect, test } from 'bun:test';
import { MeetingDetectionPoller, PollClock } from '../../src/lib/meeting-detection-poller';
import type { AudioActivity } from '../../src/lib/meeting-detection';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const pending: ReturnType<typeof deferred<AudioActivity[]>>[] = [];
  const received: (AudioActivity[] | null)[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const clock: PollClock = {
    schedule: fn => { timers.set(++nextTimer, fn); return nextTimer as unknown as ReturnType<typeof setTimeout>; },
    cancel: timer => { timers.delete(timer as unknown as number); },
  };
  const poller = new MeetingDetectionPoller(() => { const item = deferred<AudioActivity[]>(); pending.push(item); return item.promise; }, apps => received.push(apps), clock);
  return { poller, pending, received, timers, tick: () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); } };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
test('serial polling never overlaps, and stop removes timer and suppresses late completion', async () => {
  const s = setup();
  s.poller.start(); s.poller.start();
  expect(s.pending).toHaveLength(1);
  s.tick(); expect(s.pending).toHaveLength(1);
  s.pending[0].resolve([]); await settle();
  expect(s.received).toEqual([[]]);
  expect(s.timers.size).toBe(1);
  s.tick(); expect(s.pending).toHaveLength(2);
  s.poller.stop(); s.pending[1].resolve([]); await settle();
  expect(s.received).toEqual([[]]);
  expect(s.timers.size).toBe(0);
  s.poller.start(); s.pending[2].resolve([]); await settle();
  s.poller.stop(); expect(s.timers.size).toBe(0);
});
test('disable/re-enable during a query rejects the old generation without creating concurrent queries', async () => {
  const s = setup();
  s.poller.start(); s.poller.stop(); s.poller.start();
  expect(s.pending).toHaveLength(1);
  s.pending[0].resolve([]); await settle();
  expect(s.received).toEqual([]);
  s.tick(); expect(s.pending).toHaveLength(2);
  s.pending[1].reject(new Error('unavailable')); await settle();
  expect(s.received).toEqual([null]);
  expect(s.timers.size).toBe(1);
  s.poller.stop();
});
