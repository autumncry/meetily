import { RefObject, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import type { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import type { PaginatedTranscriptsResponse } from '@/types';
import { buildMeetingDocument, ExportContent, ExportFormat, renderMeetingDocument, safeFilename } from '@/lib/meeting-export';
import { collectAllTranscripts, saveMeetingExport } from '@/lib/meeting-export/save';

interface ExportProps {
  meeting: { id: string; created_at: string };
  meetingTitle: string;
  aiSummary: unknown;
  blockNoteSummaryRef: RefObject<BlockNoteSummaryViewRef>;
}

export function useExportOperations({ meeting, meetingTitle, aiSummary, blockNoteSummaryRef }: ExportProps) {
  const running = useRef(false);
  const [isExporting, setIsExporting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const exportMeeting = async (format: ExportFormat, content: ExportContent) => {
    if (running.current) return;
    running.current = true;
    setIsExporting(true);
    setError(null);
    setStatus('Preparing export…');
    try {
      // Snapshot the latest visible editor content before async transcript reads.
      const summary = content !== 'transcript' ? blockNoteSummaryRef.current?.getExportSummary() ?? aiSummary : undefined;
      const transcripts = content !== 'summary' ? await collectAllTranscripts(offset => invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', { meetingId: meeting.id, limit: 500, offset })) : [];
      const document = buildMeetingDocument({ title: meetingTitle, date: meeting.created_at, summary, transcripts, content });
      let warnings: string[] = [];
      const result = await saveMeetingExport({
        filename: safeFilename(meetingTitle, format),
        format,
        choosePath: async (filename, extension) => save({ title: 'Export meeting', defaultPath: filename, filters: [{ name: extension === 'md' ? 'Markdown' : extension === 'docx' ? 'Word document' : 'PDF document', extensions: [extension] }] }),
        render: async () => {
          setStatus('Creating document…');
          const rendered = await renderMeetingDocument(document, format);
          warnings = rendered.warnings;
          return rendered.bytes;
        },
        write: async (path, bytes) => {
          setStatus('Saving document…');
          await writeFile(path, bytes);
        },
      });
      if (result === 'cancelled') setStatus('Export cancelled.');
      else {
        setStatus(warnings.length ? `Export saved. ${warnings.join(' ')}` : 'Export saved.');
        toast.success('Meeting exported', warnings.length ? { description: warnings.join(' ') } : undefined);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus('');
      toast.error('Could not export meeting', { description: message });
    } finally {
      setIsExporting(false);
      running.current = false;
    }
  };
  return { exportMeeting, isExporting, status, error };
}
