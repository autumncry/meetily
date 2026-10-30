import { afterAll, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TranscriptSegmentData } from '../../src/types';
import { labelTranscripts, type SpeakerRun } from '../../src/lib/speakers';

const originalCore = { ...await import('@tauri-apps/api/core') };
const originalView = { ...await import('../../src/components/VirtualizedTranscriptView') };
const originalButtons = { ...await import('../../src/components/MeetingDetails/TranscriptButtonGroup') };
const rows = [
  { id: 'missing', text: '缺少开始时间，原文保留。', timestamp: '10:01', audio_end_time: 10 },
  { id: 'null', text: '空开始时间，原文保留。', timestamp: '10:02', audio_start_time: null, audio_end_time: 10 },
  { id: 'zero', text: '真实零秒开始，原文保留。', timestamp: '10:03', audio_start_time: 0, audio_end_time: 10 },
];
const run: SpeakerRun = {
  id: 'r', meeting_id: 'm', created_at: 'today', audio_hash: 'a', requested_speakers: 1, duration: 20,
  turns: [{ start: 0, end: 20, speaker: 'speaker-01' }],
  overlay: { names: { 'speaker-01': 'Alice' }, aliases: {}, undo: [] },
};
let rendered: TranscriptSegmentData[] = [];
mock.module('@tauri-apps/api/core', () => ({
  ...originalCore,
  invoke: async (command: string) => {
    if (command === 'api_get_meeting_metadata') return { id: 'm', title: 'Meeting' };
    if (command === 'api_get_meeting_transcripts') return { transcripts: rows, total_count: rows.length, has_more: false };
    throw new Error(command);
  },
}));
// Keep the actual pagination hook and panel. Replace only DOM-dependent
// virtualization and unrelated toolbar controls at their rendering boundary.
mock.module('../../src/components/VirtualizedTranscriptView', () => ({
  VirtualizedTranscriptView: ({ segments }: { segments: TranscriptSegmentData[] }) => { rendered = segments; return null; },
}));
mock.module('../../src/components/MeetingDetails/TranscriptButtonGroup', () => ({
  TranscriptButtonGroup: () => null,
}));
const { usePaginatedTranscripts } = await import('../../src/hooks/usePaginatedTranscripts');
const { TranscriptPanel } = await import('../../src/components/MeetingDetails/TranscriptPanel');
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('../../src/components/VirtualizedTranscriptView', () => originalView);
  mock.module('../../src/components/MeetingDetails/TranscriptButtonGroup', () => originalButtons);
});

test('paginated panel distinguishes missing source starts from real zero while preserving display timing and text', async () => {
  function Harness() {
    const data = usePaginatedTranscripts({ meetingId: 'm' });
    return <TranscriptPanel transcripts={data.transcripts} segments={data.segments} usePagination
      speakerRun={run} customPrompt="" onPromptChange={() => {}} onCopyTranscript={() => {}}
      onOpenMeetingFolder={async () => {}} isRecording={false} />;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness />); });
  try {
    expect(rendered.map(row => row.speakerLabel)).toEqual([
      'Ambiguous (missing time bounds)', 'Ambiguous (missing time bounds)', 'Alice',
    ]);
    expect(rendered.map(row => row.timestamp)).toEqual([0, 0, 0]);
    expect(rendered.map(row => row.endTime)).toEqual([10, 10, 10]);
    expect(rendered.map(row => row.text)).toEqual(rows.map(row => row.text));
    const exports = labelTranscripts(rows.map(row => ({ ...row, audio_start_time: row.audio_start_time ?? undefined })), run);
    expect(rendered.map(row => row.speakerLabel)).toEqual(exports.map(row => row.speakerLabel));
  } finally {
    await act(async () => renderer.unmount());
  }
});
