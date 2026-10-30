import { ExportFormat, MeetingDocument, safeFilename } from './model';
import { renderMarkdown } from './markdown';
import { ExportFonts, loadExportFonts } from './fonts';
export * from './model';
export type { ExportFonts } from './fonts';

export interface RenderedMeetingDocument { bytes: Uint8Array; filename: string; mime: string; warnings: string[] }
export async function renderMeetingDocument(document: MeetingDocument, format: ExportFormat, options: { fonts?: ExportFonts } = {}): Promise<RenderedMeetingDocument> {
  const filename = safeFilename(document.title, format);
  if (format === 'md') return { bytes: renderMarkdown(document), filename, mime: 'text/markdown;charset=utf-8', warnings: document.warnings };
  const fonts = options.fonts || await loadExportFonts();
  if (format === 'docx') {
    const { renderDocx } = await import('./docx');
    return { bytes: await renderDocx(document, fonts), filename, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', warnings: document.warnings };
  }
  const { renderPdf } = await import('./pdf');
  return { ...await renderPdf(document, fonts), filename, mime: 'application/pdf' };
}
