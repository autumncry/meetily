import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { createRef } from 'react';
import type { BlockNoteSummaryViewRef } from '../../src/components/AISummary/BlockNoteSummaryView';

const originalCore = { ...await import('@tauri-apps/api/core') };
const originalDialog = { ...await import('@tauri-apps/plugin-dialog') };
const originalFs = { ...await import('@tauri-apps/plugin-fs') };
const originalToast = { ...await import('sonner') };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/plugin-dialog', () => originalDialog);
  mock.module('@tauri-apps/plugin-fs', () => originalFs);
  mock.module('sonner', () => originalToast);
});
const rows = Array.from({ length: 503 }, (_, i) => ({ id: `${i}`, text: `完整记录 ${i}`, audio_start_time: i, timestamp: '' }));
let path: string | null;
let writeError: Error | null;
let written: Uint8Array | null;
const success = mock(() => {});
mock.module('sonner', () => ({ toast: { success, error: () => {} } }));
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke: async (command: string, args: { offset: number; limit: number }) => {
  if (command !== 'api_get_meeting_transcripts') throw new Error(command);
  return { transcripts: rows.slice(args.offset, args.offset + args.limit), total_count: rows.length, has_more: args.offset + args.limit < rows.length };
} }));
mock.module('@tauri-apps/plugin-dialog', () => ({ ...originalDialog, save: async () => path }));
mock.module('@tauri-apps/plugin-fs', () => ({ ...originalFs, writeFile: async (_path: string, bytes: Uint8Array) => {
  if (writeError) throw writeError;
  written = bytes;
} }));
const { useExportOperations } = await import('../../src/hooks/meeting-details/useExportOperations');
let hook: ReturnType<typeof useExportOperations>;
let renderer: ReactTestRenderer;
const ref = createRef<BlockNoteSummaryViewRef>();
function Harness() {
  hook = useExportOperations({ meeting: { id: 'test', created_at: '2026-10-30' }, meetingTitle: '导出测试', aiSummary: { markdown: 'Old summary' }, blockNoteSummaryRef: ref });
  return null;
}
beforeEach(async () => {
  path = '/tmp/export.md'; writeError = null; written = null; success.mockClear();
  (ref as any).current = { getExportSummary: () => ({ summary_json: [{ type: 'paragraph', content: [{ text: 'Live edited summary' }] }] }) };
  await act(async () => { renderer = create(<Harness />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });

describe('export hook integration', () => {
  test('exports latest editor contents and every transcript page using the production renderer', async () => {
    await act(async () => { await hook.exportMeeting('md', 'both'); });
    const text = new TextDecoder().decode(written!);
    expect(text).toContain('Live edited summary');
    expect(text).not.toContain('Old summary');
    expect(text).toContain('完整记录 502');
    expect(text.match(/完整记录 /g)).toHaveLength(503);
    expect(hook.status).toBe('Export saved.');
    expect(hook.isExporting).toBe(false);
  });
  test('cancellation has visible state and never reports success', async () => {
    path = null;
    await act(async () => { await hook.exportMeeting('md', 'transcript'); });
    expect(written).toBeNull();
    expect(hook.status).toBe('Export cancelled.');
    expect(success).not.toHaveBeenCalled();
  });
  test('write errors remain visible and allow a successful retry', async () => {
    writeError = new Error('Disk is full');
    await act(async () => { await hook.exportMeeting('md', 'summary'); });
    expect(hook.error).toBe('Disk is full');
    expect(hook.isExporting).toBe(false);
    expect(success).not.toHaveBeenCalled();
    writeError = null;
    await act(async () => { await hook.exportMeeting('md', 'summary'); });
    expect(hook.error).toBeNull();
    expect(hook.status).toBe('Export saved.');
  });
  test('empty live editor contents never revive an older persisted summary', async () => {
    (ref as any).current = { getExportSummary: () => ({ summary_json: [] }) };
    await act(async () => { await hook.exportMeeting('md', 'summary'); });
    expect(hook.error).toContain('No summary');
    expect(written).toBeNull();
  });
});
