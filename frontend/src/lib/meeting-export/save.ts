import type { ExportFormat, ExportTranscript } from './model';

export async function collectAllTranscripts<T extends ExportTranscript>(readPage: (offset: number) => Promise<{ transcripts: T[]; total_count: number; has_more: boolean }>): Promise<T[]> {
  const rows: T[] = [];
  let expected: number | undefined;
  while (true) {
    const page = await readPage(rows.length);
    expected ??= page.total_count;
    if (expected !== page.total_count) throw new Error('Transcript changed during export. Please try again.');
    rows.push(...page.transcripts);
    if (!page.has_more) {
      if (rows.length !== expected) throw new Error('Could not load the complete transcript.');
      const ids = rows.map(r => r.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw new Error('Transcript pagination returned duplicate segments. Please try again.');
      return rows;
    }
    if (!page.transcripts.length || rows.length >= expected) throw new Error('Incomplete transcript pagination.');
  }
}

export async function saveMeetingExport(options: {
  filename: string;
  format: ExportFormat;
  choosePath: (filename: string, format: ExportFormat) => Promise<string | null>;
  render: () => Promise<Uint8Array>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
}): Promise<'saved' | 'cancelled'> {
  const path = await options.choosePath(options.filename, options.format);
  if (path === null) return 'cancelled';
  const bytes = await options.render();
  await options.write(path, bytes);
  return 'saved';
}
