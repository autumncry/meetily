import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType, Footer, PageNumber, ExternalHyperlink, LevelFormat, ILevelsOptions } from 'docx';
import { DocumentBlock, Inline, MeetingDocument } from './model';
import type { ExportFonts } from './fonts';

const font = { ascii: 'Noto Sans SC', hAnsi: 'Noto Sans SC', eastAsia: 'Noto Sans SC', cs: 'Noto Sans SC' };
function textRuns(runs: Inline[]): (TextRun | ExternalHyperlink)[] {
  return runs.flatMap(r => r.text.split('\n').flatMap((line, index) => {
    const pieces: (TextRun | ExternalHyperlink)[] = index ? [new TextRun({ break: 1 })] : [];
    // Assign emoji explicitly so Word does not need an OS-specific fallback.
    const parts = line.match(/\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F\u200D\p{Extended_Pictographic}]*|[^\p{Extended_Pictographic}]+/gu) || [];
    const children = parts.map(text => new TextRun({ text, font: /\p{Extended_Pictographic}/u.test(text) ? 'Noto Emoji' : font, bold: r.bold, italics: r.italic, strike: r.strike, underline: r.underline || r.href ? {} : undefined, shading: r.code ? { fill: 'F1F5F9' } : undefined }));
    if (r.href && /^(https?:|mailto:)/i.test(r.href)) pieces.push(new ExternalHyperlink({ link: r.href, children }));
    else pieces.push(...children);
    return pieces;
  }));
}
function paragraph(block: DocumentBlock, numbering?: { reference: string; level: number }): Paragraph {
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  return new Paragraph({
    heading: block.kind === 'heading' ? headings[(block.level || 1) - 1] : undefined,
    children: textRuns(block.runs),
    numbering,
    indent: block.kind === 'list' ? { left: 360 * ((block.depth || 0) + 1), hanging: 240 } : block.kind === 'quote' ? { left: 360 } : undefined,
    spacing: { after: 140, line: 320 },
    keepNext: block.kind === 'heading',
    shading: block.kind === 'code' ? { fill: 'F1F5F9' } : undefined,
  });
}
export async function renderDocx(document: MeetingDocument, fonts: ExportFonts): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: document.title, heading: HeadingLevel.TITLE }), new Paragraph({ text: `Date: ${document.date}`, spacing: { after: 280 } })];
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = [];
  const activeLists = new Map<number, { reference: string; marker: string; ordinal: number }>();
  for (const block of document.blocks) {
    if (block.kind === 'list') {
      const level = Math.min(8, block.depth || 0);
      const ordinal = /^\d+\.$/.test(block.marker || '') ? parseInt(block.marker!, 10) : 0;
      const marker = ordinal ? 'number' : block.marker || '•';
      const previous = activeLists.get(level);
      let reference = previous?.reference;
      if (!previous || previous.marker !== marker || ordinal && ordinal !== previous.ordinal + 1) {
        reference = `meeting-list-${numbering.length}`;
        numbering.push({ reference, levels: Array.from({ length: 9 }, (_, i) => ({
          level: i,
          format: ordinal ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordinal ? `%${i + 1}.` : marker === '[x]' ? '☒' : marker === '[ ]' ? '☐' : '•',
          start: i === level && ordinal ? ordinal : 1,
          style: { run: { font }, paragraph: { indent: { left: 360 * (i + 1), hanging: 240 } } },
        })) });
      }
      // Returning to a shallower level ends the nested sequence; the next child
      // list can restart from its own source ordinal without disturbing parents.
      for (const depth of activeLists.keys()) if (depth > level) activeLists.delete(depth);
      activeLists.set(level, { reference: reference!, marker, ordinal });
      children.push(paragraph(block, { reference: reference!, level }));
    } else if (block.kind !== 'table' || !block.rows?.length) {
      if (!block.depth) activeLists.clear();
      children.push(paragraph(block));
    }
    else {
      activeLists.clear();
      const columns = Math.max(...block.rows.map(row => row.length));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({
        tableHeader: index === 0,
        children: Array.from({ length: columns }, (_, i) => new TableCell({ width: { size: 100 / columns, type: WidthType.PERCENTAGE }, shading: index === 0 ? { fill: 'EAF0F6' } : undefined, children: [new Paragraph({ children: textRuns(row[i] || []), spacing: { after: 100, line: 300 } })] })),
      })) }));
    }
  }
  if (document.warnings.length) {
    children.push(new Paragraph({ text: 'Export notes', heading: HeadingLevel.HEADING_2 }), ...document.warnings.map(text => new Paragraph({ text })));
  }
  const doc = new Document({
    title: document.title,
    creator: 'Meetily Personal',
    description: `Meeting date: ${document.date}`,
    numbering: { config: numbering },
    // docx accepts Uint8Array at runtime; its public type still calls this Buffer.
    fonts: [{ name: 'Noto Sans SC', data: fonts.cjk as Buffer }, { name: 'Noto Emoji', data: fonts.emoji as Buffer }],
    styles: { default: { document: { run: { font, size: 22 }, paragraph: { spacing: { line: 320 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: 'center', children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) }, children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
