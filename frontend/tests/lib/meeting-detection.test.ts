import { describe, expect, test } from 'bun:test';
import { MeetingDetectionPolicy, parseDetectionPreferences } from '../../src/lib/meeting-detection';
const id = 'com.electron.lark';
const allowed = [id];
const activity = [{ bundleId: id, inputActive: true, outputActive: true }];
function feed(policy: MeetingDetectionPolicy, from: number, to: number, apps = activity, busy = false) {
  let reminder: string | null = null;
  for (let now = from; now <= to; now += 1000) reminder = policy.observe(apps, now, allowed, busy) ?? reminder;
  return reminder;
}
describe('meeting reminder policy', () => {
  test('requires five seconds of continuous allowed input and output, then reminds only once', () => {
    const policy = new MeetingDetectionPolicy();
    expect(feed(policy, 0, 4000)).toBeNull();
    expect(feed(policy, 5000, 5000)).toBe(id);
    expect(feed(policy, 6000, 60000)).toBeNull();
  });
  test('playback, input only, disallowed apps and our own bundle never remind', () => {
    for (const apps of [
      [{ bundleId: id, inputActive: false, outputActive: true }],
      [{ bundleId: id, inputActive: true, outputActive: false }],
      [{ bundleId: 'other.app', inputActive: true, outputActive: true }],
      [{ bundleId: 'com.autumncry.meetily.personal', inputActive: true, outputActive: true }],
    ]) expect(feed(new MeetingDetectionPolicy(), 0, 60000, apps)).toBeNull();
  });
  test('only thirty seconds of confirmed no I/O resets a consumed episode', () => {
    const policy = new MeetingDetectionPolicy();
    expect(feed(policy, 0, 5000)).toBe(id);
    feed(policy, 6000, 34000, []);
    expect(feed(policy, 35000, 40000)).toBeNull();
    feed(policy, 41000, 71000, []);
    expect(feed(policy, 72000, 77000)).toBe(id);
  });
  test('unknown queries and sleep gaps never count toward stability or ending an episode', () => {
    const policy = new MeetingDetectionPolicy();
    feed(policy, 0, 4000);
    policy.observe(null, 5000, allowed, false);
    expect(feed(policy, 6000, 10000)).toBeNull();
    expect(feed(policy, 11000, 11000)).toBe(id);
    feed(policy, 12000, 20000, []);
    policy.observe(null, 50000, allowed, false);
    feed(policy, 51000, 79000, []);
    expect(feed(policy, 80000, 90000)).toBeNull();
    const fresh = new MeetingDetectionPolicy();
    fresh.observe(activity, 0, allowed, false);
    expect(fresh.observe(activity, 60000, allowed, false)).toBeNull();
  });
  test('manual, paused or busy recording consumes activity rather than queuing a reminder', () => {
    const policy = new MeetingDetectionPolicy();
    expect(feed(policy, 0, 10000, activity, true)).toBeNull();
    expect(feed(policy, 11000, 60000)).toBeNull();
  });
  test('Off clears continuity but retains a consumed episode across toggle', () => {
    const policy = new MeetingDetectionPolicy();
    feed(policy, 0, 4000);
    policy.suspend();
    expect(feed(policy, 5000, 9000)).toBeNull();
    expect(feed(policy, 10000, 10000)).toBe(id);
    policy.suspend();
    expect(feed(policy, 20000, 40000)).toBeNull();
  });
});
test('preferences fail closed and browsers require explicit selection', () => {
  for (const value of [undefined, null, {}, { mode: 'automatic', allowedBundleIds: [id] }, { mode: 'ask', allowedBundleIds: 'bad' }]) {
    expect(parseDetectionPreferences(value).mode).toBe('off');
  }
  expect(parseDetectionPreferences(null).allowedBundleIds).toEqual([id, 'com.alibaba.DingTalkMac', 'com.tencent.xinWeChat']);
  expect(parseDetectionPreferences({ mode: 'ask', allowedBundleIds: [id, id, 'evil', 'com.google.Chrome'] })).toEqual({ mode: 'ask', allowedBundleIds: [id, 'com.google.Chrome'] });
});
