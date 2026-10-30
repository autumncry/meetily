import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { createRef } from 'react';
import { readFile } from 'node:fs/promises';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
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
  test('latest structured numbered lists remain nested in the saved Markdown AST', async () => {
    (ref as any).current = { getExportSummary: () => ({ summary_json: [
      { type: 'numberedListItem', props: { start: 12 }, content: [{ text: 'Parent' }], children: [{ type: 'numberedListItem', content: [{ text: 'Child' }] }] },
      { type: 'numberedListItem', content: [{ text: 'Parent two' }] },
    ] }) };
    await act(async () => { await hook.exportMeeting('md', 'summary'); });
    const tree = unified().use(remarkParse).use(remarkGfm).parse(new TextDecoder().decode(written!));
    const list: any = tree.children.find(node => node.type === 'list');
    expect(list.start).toBe(12);
    expect(list.children).toHaveLength(2);
    const nested = list.children[0].children.find((node: any) => node.type === 'list');
    expect(nested?.ordered).toBe(true);
    expect(nested?.children[0].children[0].children[0].value).toBe('Child');
  });
  test('unsupported PDF characters show an error without writing or success, then Markdown preserves the original on retry', async () => {
    (ref as any).current = { getExportSummary: () => ({ markdown: 'Preserve custom character \u{F0000}' }) };
    const originalFetch = globalThis.fetch;
    // Only the native/browser asset boundary is replaced. Font bytes and the
    // entire PDF renderer are real production code, with no remote request.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const filename = String(url).split('/').at(-1)!;
      const bytes = await readFile(new URL(`../../public/fonts/${filename}`, import.meta.url));
      return new Response(Uint8Array.from(bytes));
    }) as typeof fetch;
    try {
      await act(async () => { await hook.exportMeeting('pdf', 'summary'); });
      expect(hook.error).toContain('U+F0000');
      expect(hook.error).toContain('Markdown or DOCX');
      expect(hook.isExporting).toBe(false);
      expect(written).toBeNull();
      expect(success).not.toHaveBeenCalled();
      await act(async () => { await hook.exportMeeting('md', 'summary'); });
      expect(hook.error).toBeNull();
      expect(new TextDecoder().decode(written!)).toContain('\u{F0000}');
      expect(success).toHaveBeenCalledTimes(1);
    } finally { globalThis.fetch = originalFetch; }
  }, 60000);
});
