export interface SpeakerTurn { start: number; end: number; speaker: string }
export interface SpeakerRun {
  id: string; meeting_id: string; created_at: string; audio_hash: string;
  requested_speakers: number; duration: number; turns: SpeakerTurn[];
  overlay: { names: Record<string, string>; aliases: Record<string, string>; undo: Record<string, string>[] };
}
export interface SpeakerSnapshot { active_id: string | null; runs: SpeakerRun[] }
export function speakerRoot(run: SpeakerRun, id: string): string {
  const seen=new Set<string>();
  while(run.overlay.aliases[id] && !seen.has(id)) { seen.add(id); id=run.overlay.aliases[id]; }
  return id;
}
export function speakerName(run: SpeakerRun, id: string): string {
  const root=speakerRoot(run,id); return run.overlay.names[root] || root;
}
export function intervalLabel(run: SpeakerRun | undefined, start?: number, end?: number): string | undefined {
  if(!run) return undefined;
  if(start==null || end==null || !Number.isFinite(start) || !Number.isFinite(end) || end<=start) return 'Ambiguous (missing time bounds)';
  const ids=[...new Set(run.turns.filter(t=>t.end>start && t.start<end).map(t=>speakerRoot(run,t.speaker)))];
  if(!ids.length) return 'Unassigned';
  const labels=ids.map(id=>speakerName(run,id));
  return ids.length>1 ? 'Mixed / ambiguous: '+labels.join(' · ') : labels[0];
}
export function labelTranscripts<T extends { audio_start_time?: number; audio_end_time?: number; chunk_start_time?: number }>(rows: T[], run?: SpeakerRun): (T & { speakerLabel?: string })[] {
  return rows.map(row=>({...row,speakerLabel:intervalLabel(run,row.audio_start_time ?? row.chunk_start_time,row.audio_end_time)}));
}
