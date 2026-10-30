import { afterAll, afterEach, beforeEach, expect, mock, test, spyOn } from 'bun:test';
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
const originalCore = { ...await import('@tauri-apps/api/core') };
const originalStore = { ...await import('@tauri-apps/plugin-store') };
const originalNav = { ...await import('next/navigation') };
const originalState = { ...await import('../../src/contexts/RecordingStateContext') };
const savedGlobals = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let path = '/';
let navigation: string[] = [];
let commands: string[] = [];
let preference: unknown;
let loadFailure = false;
let saveFailures = 0;
let recording = { isRecording: false, isPaused: false, status: originalState.RecordingStatus.IDLE };
let nativeRecording = false;
let nativeDeferred: Promise<any> | null = null;
let snapshotDeferred: Promise<any> | null = null;
let snapshotFailure = false;
let apps = [{ bundleId: 'com.electron.lark', pids: [42], inputActive: true, outputActive: true }];
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke: async (command: string, args?: { allowedBundleIds?: string[] }) => {
  commands.push(command);
  if (command === 'api_get_meetings') return [];
  if (command === 'get_meeting_audio_snapshot') {
    if (!Array.isArray(args?.allowedBundleIds)) throw new Error('Snapshot allowlist was not provided');
    if (snapshotFailure) throw new Error('unavailable');
    return snapshotDeferred ?? apps.filter(app => args.allowedBundleIds!.includes(app.bundleId));
  }
  if (command === 'get_recording_state') return nativeDeferred ?? { is_recording: nativeRecording, is_paused: nativeRecording, is_active: nativeRecording, recording_duration: null, active_duration: null };
  throw new Error(`Unexpected native command ${command}`);
} }));
mock.module('@tauri-apps/plugin-store', () => ({ ...originalStore, Store: { load: async () => {
  if (loadFailure) throw new Error('cannot read');
  return { get: async () => preference, set: async (_key: string, value: unknown) => { preference = value; }, save: async () => { if (saveFailures-- > 0) throw new Error('disk full'); } };
} } }));
mock.module('next/navigation', () => ({ ...originalNav, usePathname: () => path, useRouter: () => ({ push: (route: string) => { navigation.push(route); } }) }));
mock.module('../../src/contexts/RecordingStateContext', () => ({ ...originalState, useRecordingState: () => recording }));
const { SidebarProvider } = await import('../../src/components/Sidebar/SidebarProvider');
const { MeetingDetectionProvider, useMeetingDetection } = await import('../../src/contexts/MeetingDetectionProvider');
const { MeetingDetectionSettings } = await import('../../src/components/MeetingDetectionSettings');
let context: ReturnType<typeof useMeetingDetection>;
function Harness() { context = useMeetingDetection(); return <MeetingDetectionSettings />; }
let renderer: ReactTestRenderer | null = null;
let now = 0;
let timerId = 0;
let timers = new Map<number, () => void>();
let timeSpy: ReturnType<typeof spyOn>;
let startEvents = 0;
let session = new Map<string, string>();
function tree(ready = true) { return <SidebarProvider><MeetingDetectionProvider ready={ready}><Harness /></MeetingDetectionProvider></SidebarProvider>; }
async function mount(ready = true) { await act(async () => { renderer = create(tree(ready)); }); }
async function tick(seconds = 1) {
  for (let i = 0; i < seconds; i++) {
    now += 1000;
    const callbacks = [...timers.values()]; timers.clear();
    await act(async () => { callbacks.forEach(fn => fn()); });
  }
}
function button(label: string) { return renderer!.root.findAllByType('button').find(node => node.children.join('') === label); }
beforeEach(() => {
  path = '/'; navigation = []; commands = []; preference = { mode: 'ask', allowedBundleIds: ['com.electron.lark'] };
  loadFailure = false; saveFailures = 0; nativeRecording = false; nativeDeferred = null; snapshotDeferred = null; snapshotFailure = false;
  recording = { isRecording: false, isPaused: false, status: originalState.RecordingStatus.IDLE };
  apps = [{ bundleId: 'com.electron.lark', pids: [42], inputActive: true, outputActive: true }];
  now = 0; timerId = 0; timers = new Map(); startEvents = 0; session = new Map();
  const events = new EventTarget(); events.addEventListener('start-recording-from-sidebar', () => startEvents++);
  globalThis.window = events as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = {
    setItem: (key, value) => { session.set(key, value); },
    getItem: key => session.get(key) ?? null,
    get length() { return session.size; }, clear: () => session.clear(),
    key: index => [...session.keys()][index] ?? null, removeItem: key => { session.delete(key); },
  };
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 0 || ms === 1000) { timers.set(++timerId, fn); return timerId; }
    return savedGlobals.setTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (timers.has(id)) timers.delete(id); else savedGlobals.clearTimeout(id); }) as typeof clearTimeout;
  timeSpy = spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); }); renderer = null;
  timeSpy.mockRestore(); Object.assign(globalThis, savedGlobals);
});
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/plugin-store', () => originalStore);
  mock.module('next/navigation', () => originalNav);
  mock.module('../../src/contexts/RecordingStateContext', () => originalState);
});
test('Off default, invalid preferences, failed load and incomplete onboarding do not observe', async () => {
  preference = undefined; await mount(); expect(context.preferences.mode).toBe('off'); expect(commands).not.toContain('get_meeting_audio_snapshot');
  await act(async () => renderer!.unmount()); renderer = null;
  preference = { mode: 'automatic', allowedBundleIds: ['com.electron.lark'] }; await mount(); expect(context.preferences.mode).toBe('off');
  await act(async () => renderer!.unmount()); renderer = null;
  loadFailure = true; await mount(); expect(context.error).toBeTruthy(); expect(context.preferences.mode).toBe('off');
  await act(async () => renderer!.unmount()); renderer = null;
  loadFailure = false; preference = { mode: 'ask', allowedBundleIds: ['com.electron.lark'] }; await mount(false);
  await tick(6); expect(commands).not.toContain('get_meeting_audio_snapshot');
});
test('stable activity presents Start and Ignore; ignored episodes never queue a second reminder', async () => {
  await mount(); await tick(4); expect(button('Start recording')).toBeUndefined();
  await tick(); expect(button('Start recording')).toBeDefined();
  expect(JSON.stringify(renderer!.toJSON())).toContain('Lark');
  await act(async () => { button('Ignore this meeting')!.props.onClick(); });
  await tick(10); expect(button('Start recording')).toBeUndefined();
  expect(startEvents).toBe(0);
});
test('double click on home uses the existing Sidebar start event only once', async () => {
  await mount(); await tick(5);
  const start = button('Start recording')!;
  await act(async () => { await Promise.all([start.props.onClick(), start.props.onClick()]); });
  expect(startEvents).toBe(1); expect(navigation).toEqual([]);
  expect(commands.some(c => c.startsWith('start_recording') || c.startsWith('stop_recording'))).toBe(false);
  await tick(6); expect(button('Start recording')).toBeUndefined();
});
test('start on another route uses existing Sidebar navigation/start signal', async () => {
  path = '/settings'; await mount(); await tick(5);
  await act(async () => { await button('Start recording')!.props.onClick(); });
  expect(navigation).toEqual(['/']); expect(session.get('autoStartRecording')).toBe('true'); expect(startEvents).toBe(0);
});
test('native already-recording state suppresses start even if React state is stale', async () => {
  await mount(); await tick(5); nativeRecording = true;
  await act(async () => { await button('Start recording')!.props.onClick(); });
  expect(startEvents).toBe(0); expect(button('Start recording')).toBeUndefined();
});
test('paused and lifecycle-busy activity is consumed before manual recording ends', async () => {
  recording = { isRecording: true, isPaused: true, status: originalState.RecordingStatus.RECORDING };
  await mount(); await tick(5); expect(button('Start recording')).toBeUndefined();
  recording = { isRecording: false, isPaused: false, status: originalState.RecordingStatus.IDLE };
  await act(async () => { renderer!.update(tree()); }); await tick(6);
  expect(button('Start recording')).toBeUndefined();
});
test('Off removes reminder and timers, and a captured stale Start cannot initiate recording', async () => {
  await mount(); await tick(5); const start = button('Start recording')!.props.onClick;
  await act(async () => { await context.updatePreferences({ ...context.preferences, mode: 'off' }); });
  expect(button('Start recording')).toBeUndefined(); expect(timers.size).toBe(0);
  await act(async () => { await start(); }); expect(startEvents).toBe(0);
  await act(async () => { await context.updatePreferences({ ...context.preferences, mode: 'ask' }); });
  await tick(6); expect(button('Start recording')).toBeUndefined();
});
test('a pending native state recheck cannot start after disable', async () => {
  await mount(); await tick(5);
  let resolve!: (value: any) => void; nativeDeferred = new Promise(done => { resolve = done; });
  let click!: Promise<void>;
  await act(async () => { click = button('Start recording')!.props.onClick(); });
  await act(async () => { await context.updatePreferences({ ...context.preferences, mode: 'off' }); });
  await act(async () => { resolve({ is_recording: false, is_paused: false }); await click; });
  expect(startEvents).toBe(0);
});
test('snapshot errors dismiss stale reminders and expose unavailable state without starting', async () => {
  await mount(); await tick(5); snapshotFailure = true; await tick();
  expect(context.health).toBe('unavailable'); expect(button('Start recording')).toBeUndefined(); expect(startEvents).toBe(0);
});
test('save failure rolls back both settings UI and stored value with visible error', async () => {
  preference = undefined; await mount(); saveFailures = 1;
  await act(async () => { await context.updatePreferences({ mode: 'ask', allowedBundleIds: ['com.electron.lark'] }); });
  expect(context.preferences.mode).toBe('off'); expect((preference as any).mode).toBe('off');
  expect(context.error).toContain('save'); expect(JSON.stringify(renderer!.toJSON())).toContain(context.error!);
  expect(commands).not.toContain('get_meeting_audio_snapshot');
});
test('failed settings save while Ask is enabled resumes observation of the retained selection', async () => {
  await mount(); await tick(2); saveFailures = 1;
  await act(async () => { await context.updatePreferences({ ...context.preferences, allowedBundleIds: [] }); });
  const queryCount = commands.filter(command => command === 'get_meeting_audio_snapshot').length;
  await tick(2);
  expect(context.preferences.mode).toBe('ask');
  expect(context.preferences.allowedBundleIds).toEqual(['com.electron.lark']);
  expect(commands.filter(command => command === 'get_meeting_audio_snapshot').length).toBeGreaterThan(queryCount);
});
test('settings switch and browser selection persist through their rendered controls', async () => {
  preference = undefined; await mount();
  const inputs = renderer!.root.findAllByType('input');
  expect(inputs.map(input => input.props.checked)).toEqual([false, true, true, true, false, false]);
  await act(async () => { await inputs[0].props.onChange({ target: { checked: true } }); });
  expect(context.preferences.mode).toBe('ask');
  await act(async () => { await renderer!.root.findAllByType('input')[4].props.onChange({ target: { checked: true } }); });
  expect((preference as any).allowedBundleIds).toContain('com.google.Chrome');
  expect(renderer!.root.findAllByType('input')[4].props.checked).toBe(true);
});
test('batched settings updates cannot leave an enabled detector stopped', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { renderer = create(tree(), { unstable_isConcurrent: true } as any); });
    await tick(2); saveFailures = 1;
    await act(async () => { await context.updatePreferences({ ...context.preferences, allowedBundleIds: [] }); });
    const count = commands.filter(command => command === 'get_meeting_audio_snapshot').length;
    await tick(2);
    expect(commands.filter(command => command === 'get_meeting_audio_snapshot').length).toBeGreaterThan(count);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); }); renderer = null;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
test('failed disk rollback fails closed for this run and makes the uncertainty visible', async () => {
  await mount(); saveFailures = 2;
  await act(async () => { await context.updatePreferences({ ...context.preferences, mode: 'off' }); });
  expect(context.preferences.mode).toBe('off'); expect(timers.size).toBe(0);
  expect(context.error).toContain('check settings after restarting');
});
test('StrictMode and disable/re-enable during a query keep one observer and discard the old result', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (value: any) => void; snapshotDeferred = new Promise(done => { resolve = done; });
  const strictTree = (ready: boolean) => <React.StrictMode>{tree(ready)}</React.StrictMode>;
  try {
    await act(async () => { renderer = create(strictTree(true), { unstable_isConcurrent: true } as any); });
    expect(commands.filter(command => command === 'get_meeting_audio_snapshot')).toHaveLength(1);
    await act(async () => { renderer!.update(strictTree(false)); });
    await act(async () => { renderer!.update(strictTree(true)); });
    expect(commands.filter(command => command === 'get_meeting_audio_snapshot')).toHaveLength(1);
    snapshotDeferred = null;
    await act(async () => { resolve(apps); });
    expect(button('Start recording')).toBeUndefined();
    await tick(5); expect(button('Start recording')).toBeUndefined();
    await tick(); expect(button('Start recording')).toBeDefined();
    await act(async () => { renderer!.unmount(); }); renderer = null;
    expect(timers.size).toBe(0);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); }); renderer = null;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
test('unmount while querying discards late activity and never leaves a poll timer', async () => {
  let resolve!: (value: any) => void; snapshotDeferred = new Promise(done => { resolve = done; });
  await mount(); expect(commands).toContain('get_meeting_audio_snapshot');
  await act(async () => { renderer!.unmount(); }); renderer = null;
  await act(async () => { resolve(apps); }); expect(timers.size).toBe(0); expect(startEvents).toBe(0);
});
