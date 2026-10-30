import { expect, test } from 'bun:test';
import { intervalLabel, labelTranscripts, SpeakerRun } from '../../src/lib/speakers';
import { buildMeetingDocument } from '../../src/lib/meeting-export/model';
import { renderMarkdown } from '../../src/lib/meeting-export/markdown';
const run: SpeakerRun = { id:'r',meeting_id:'m',created_at:'today',audio_hash:'a',requested_speakers:2,duration:20,
  turns:[{start:0,end:5,speaker:'speaker-01'},{start:4,end:10,speaker:'speaker-02'}],
  overlay:{names:{'speaker-01':'张老师','speaker-02':'李老师'},aliases:{},undo:[]} };
test('single, mixed, overlapping, gaps and missing bounds do not invent fine attribution', () => {
  expect(intervalLabel(run,1,3)).toBe('张老师');
  expect(intervalLabel(run,1,9)).toBe('Mixed / ambiguous: 张老师 · 李老师');
  expect(intervalLabel(run,4.1,4.9)).toBe('Mixed / ambiguous: 张老师 · 李老师');
  expect(intervalLabel(run,11,12)).toBe('Unassigned');
  expect(intervalLabel(run,1)).toBe('Ambiguous (missing time bounds)');
  expect(intervalLabel(undefined,1,3)).toBeUndefined();
  expect(intervalLabel({...run,overlay:{...run.overlay,aliases:{'speaker-02':'speaker-01'}}},1,9)).toBe('张老师');
});
test('normalized exports derive current names and retain exact original text and timestamps', () => {
  const source=[{text:'原始文本，一字不改。',audio_start_time:1,audio_end_time:3},{text:'连续长句。',audio_start_time:3,audio_end_time:9}];
  const labeled=labelTranscripts(source,run);
  const doc=buildMeetingDocument({title:'会议',date:'2026',content:'transcript',transcripts:labeled});
  const text=new TextDecoder().decode(renderMarkdown(doc));
  expect(text).toContain('张老师');
  expect(text).toContain('Mixed / ambiguous');
  expect(text).toContain('00:00:01');
  for(const row of source) expect(text).toContain(row.text);
  expect(source[0]).not.toHaveProperty('speakerLabel');
});
