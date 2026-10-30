import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ExportContent, ExportFormat } from '@/lib/meeting-export';

interface Props {
  hasSummary: boolean;
  hasTranscript: boolean;
  isExporting: boolean;
  status: string;
  error: string | null;
  onExport: (format: ExportFormat, content: ExportContent) => Promise<void>;
}
export function ExportControl({ hasSummary, hasTranscript, isExporting, status, error, onExport }: Props) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [content, setContent] = useState<ExportContent>('both');
  const effectiveContent = !hasSummary ? 'transcript' : !hasTranscript ? 'summary' : content;
  const selectClass = 'h-9 rounded-md border border-gray-300 bg-white px-2 text-sm disabled:opacity-50';
  return <div className="border-b border-gray-200 bg-white px-4 py-2">
    <div className="flex flex-wrap items-center justify-end gap-2">
      <label className="sr-only" htmlFor="export-content">Export content</label>
      <select id="export-content" className={selectClass} value={effectiveContent} onChange={e => setContent(e.target.value as ExportContent)} disabled={isExporting}>
        <option value="both" disabled={!hasSummary || !hasTranscript}>Summary and transcript</option>
        <option value="summary" disabled={!hasSummary}>Summary</option>
        <option value="transcript" disabled={!hasTranscript}>Transcript</option>
      </select>
      <label className="sr-only" htmlFor="export-format">Export format</label>
      <select id="export-format" className={selectClass} value={format} onChange={e => setFormat(e.target.value as ExportFormat)} disabled={isExporting}>
        <option value="pdf">PDF</option><option value="docx">Word (.docx)</option><option value="md">Markdown (.md)</option>
      </select>
      <Button variant="outline" size="sm" disabled={isExporting || (!hasSummary && !hasTranscript)} onClick={() => void onExport(format, effectiveContent)}>
        {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        {isExporting ? 'Exporting…' : 'Export'}
      </Button>
    </div>
    {(status || error) && <p className={`mt-1 text-right text-xs ${error ? 'text-red-700' : 'text-gray-600'}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || status}</p>}
  </div>;
}
