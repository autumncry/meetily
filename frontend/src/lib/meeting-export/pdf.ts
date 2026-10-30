import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Inline, MeetingDocument } from './model';
import type { ExportFonts } from './fonts';

interface Glyph { text: string; font: PDFFont; width: number; run: Inline }
const PAGE_WIDTH = 595.28, PAGE_HEIGHT = 841.89, MARGIN = 48;

export async function renderPdf(document: MeetingDocument, fonts: ExportFonts): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(document.title);
  pdf.setAuthor('Meetily Personal');
  pdf.setSubject(`Meeting date: ${document.date}`);
  const cjkChars = new Set(fontkit.create(fonts.cjk).characterSet);
  const emojiChars = new Set(fontkit.create(fonts.emoji).characterSet);
  const sourceText = [document.title, document.date, ...document.warnings, ...document.blocks.flatMap(block => [block.marker || '', ...block.runs.map(run => run.text), ...(block.rows?.flat(2).map(run => run.text) || [])])].join('');
  const needsOtherFont = new Set(Array.from(sourceText.replace(/\r\n?/g, '\n')).filter(char => char !== '\n' && !cjkChars.has(char.codePointAt(0)!) && !emojiChars.has(char.codePointAt(0)!)));
  const fallbackChars = new Set(needsOtherFont.size && fonts.hanFallback ? fontkit.create(fonts.hanFallback).characterSet : []);
  const unsupported = [...needsOtherFont].filter(char => !fallbackChars.has(char.codePointAt(0)!));
  if (unsupported.length) throw new Error(`PDF cannot preserve character ${unsupported.slice(0, 5).map(char => `U+${char.codePointAt(0)!.toString(16).toUpperCase()}`).join(', ')} with the bundled fonts. Choose Markdown or DOCX to retain the original text.`);

  // Ordinary documents keep the verified compact SC subset. When rare Han
  // text needs a second CJK font, both CJK fonts use complete static TrueType:
  // fontkit's multiple-CJK subset output can extract correctly while rendering
  // invisible glyphs. Do not embed the fallback at all when it is unused.
  const cjk = await pdf.embedFont(fonts.cjk, { subset: needsOtherFont.size === 0 });
  const emoji = await pdf.embedFont(fonts.emoji, { subset: false });
  const hanFallback = needsOtherFont.size && fonts.hanFallback ? await pdf.embedFont(fonts.hanFallback, { subset: false }) : null;
  const warnings = [...document.warnings];
  let page: PDFPage;
  let y = 0;
  const newPage = () => { page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = PAGE_HEIGHT - MARGIN; };
  newPage();

  const glyphs = (runs: Inline[], size: number): Glyph[] => runs.flatMap(run => Array.from(run.text.replace(/\r\n?/g, '\n')).flatMap(char => {
    if (char === '\n') return [{ text: '\n', font: cjk, width: 0, run }];
    const code = char.codePointAt(0)!;
    const font = cjkChars.has(code) ? cjk : emojiChars.has(code) ? emoji : fallbackChars.has(code) ? hanFallback : null;
    if (font) return [{ text: char, font, width: font.widthOfTextAtSize(char, size), run }];
    // Never turn valid source text into a different searchable string and call
    // that a successful export. This throws before the native write boundary.
    throw new Error(`PDF cannot preserve character U+${code.toString(16).toUpperCase()} with the bundled fonts. Choose Markdown or DOCX to retain the original text.`);
  }));
  const wrap = (runs: Inline[], size: number, width: number): Glyph[][] => {
    const lines: Glyph[][] = [];
    let line: Glyph[] = [], used = 0;
    for (const glyph of glyphs(runs, size)) {
      if (glyph.text === '\n') { lines.push(line); line = []; used = 0; continue; }
      if (used + glyph.width > width && line.length) { lines.push(line); line = []; used = 0; }
      line.push(glyph); used += glyph.width;
    }
    lines.push(line);
    return lines;
  };
  const drawLine = (line: Glyph[], x: number, baseline: number, size: number) => {
    // Group adjacent glyphs to keep the PDF compact and its text extraction sane.
    let i = 0;
    while (i < line.length) {
      const first = line[i]; let text = '', width = 0;
      while (i < line.length && line[i].font === first.font && line[i].run === first.run) { text += line[i].text; width += line[i].width; i++; }
      page.drawText(text, { x, y: baseline, size, font: first.font, color: rgb(.12, .16, .21) });
      if (first.run.underline || first.run.href) page.drawLine({ start: { x, y: baseline - 2 }, end: { x: x + width, y: baseline - 2 }, thickness: .5, color: rgb(.25, .35, .5) });
      x += width;
    }
  };
  const paragraph = (runs: Inline[], size = 10.5, indent = 0, after = 8, heading = false) => {
    const lines = wrap(runs, size, PAGE_WIDTH - 2 * MARGIN - indent);
    const lineHeight = size * 1.65;
    // A recording timestamp/speaker label can occupy its own explicit line.
    // Keep at least the first two lines together, so its body begins on the
    // same page even when the rest of a long segment must continue later.
    if (lines.length > 1 && y - 2 * lineHeight < MARGIN) newPage();
    if (heading && y - Math.min(lines.length + 2, 5) * lineHeight < MARGIN) newPage();
    for (const line of lines) {
      if (y - lineHeight < MARGIN) newPage();
      y -= lineHeight;
      drawLine(line, MARGIN + indent, y, size);
    }
    y -= after;
  };

  paragraph([{ text: document.title }], 20, 0, 12, true);
  paragraph([{ text: `Date: ${document.date}` }], 9, 0, 20);
  for (const block of document.blocks) {
    if (block.kind === 'table' && block.rows?.length) {
      const columns = Math.max(...block.rows.map(row => row.length));
      const width = (PAGE_WIDTH - 2 * MARGIN) / columns;
      const size = 9, lineHeight = 15, padding = 5;
      for (const row of block.rows) {
        const cells = Array.from({ length: columns }, (_, i) => wrap(row[i] || [], size, width - 2 * padding));
        const count = Math.max(...cells.map(c => c.length));
        let start = 0;
        // A single very tall table row can continue on another page without loss.
        while (start < count) {
          if (y - lineHeight - 2 * padding < MARGIN) newPage();
          const fit = Math.min(count - start, Math.floor((y - MARGIN - 2 * padding) / lineHeight));
          const height = fit * lineHeight + 2 * padding;
          cells.forEach((lines, col) => {
            page.drawRectangle({ x: MARGIN + col * width, y: y - height, width, height, borderColor: rgb(.72, .76, .8), borderWidth: .5 });
            lines.slice(start, start + fit).forEach((line, index) => drawLine(line, MARGIN + col * width + padding, y - padding - (index + 1) * lineHeight + 3, size));
          });
          y -= height; start += fit;
        }
      }
      y -= 10;
    } else {
      const runs = block.kind === 'list' ? [{ text: `${block.marker} ` }, ...block.runs] : block.runs;
      const heading = block.kind === 'heading';
      paragraph(runs, heading ? Math.max(11, 18 - (block.level || 1) * 1.5) : 10.5, Math.min(120, (block.depth || 0) * 14 + (block.kind === 'quote' ? 14 : 0)), heading ? 10 : 7, heading);
    }
  }
  if (warnings.length) {
    paragraph([{ text: 'Export notes' }], 13, 0, 8, true);
    for (const warning of warnings) paragraph([{ text: warning }], 9);
  }
  const pages = pdf.getPages();
  for (const [index, p] of pages.entries()) p.drawText(`${index + 1} / ${pages.length}`, { x: MARGIN, y: 25, size: 8, font: cjk, color: rgb(.45, .48, .52) });
  return { bytes: await pdf.save(), warnings };
}
