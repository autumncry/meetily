import { DocumentBlock, Inline, MeetingDocument, plainText } from './model';

function inlineCode(value: string): string {
  // Code spans display line endings as spaces; canonicalize before escaping
  // surrounding blocks so their contents cannot become block-level syntax.
  value = value.replace(/\r\n?|\n/g, ' ');
  const fence = '`'.repeat(Math.max(1, ...(value.match(/`+/g) || []).map(run => run.length + 1)));
  // CommonMark removes one boundary space only when both ends have spaces
  // and the content is not entirely spaces. Pad backticks to keep fences apart.
  const pad = /^`|`$/.test(value) || /^ .* $/.test(value) && /[^ ]/.test(value) ? ' ' : '';
  return fence + pad + value + pad + fence;
}

function runsToMarkdown(runs: Inline[]): string {
  return runs.map(r => {
    if (!r.text || !r.code && !r.text.trim()) return r.text;
    const leading = r.code ? '' : r.text.match(/^\s*/)?.[0] || '';
    const trailing = r.code ? '' : r.text.match(/\s*$/)?.[0] || '';
    let text = r.code ? inlineCode(r.text) : r.text.trim().replace(/([\\`*_\[\]<>~#&])/g, '\\$1');
    if (r.bold) text = `**${text}**`;
    if (r.italic) text = `*${text}*`;
    if (r.strike) text = `~~${text}~~`;
    if (r.href) text = `[${text}](${r.href.replace(/[()\s]/g, c => encodeURIComponent(c))})`;
    return leading + text + trailing;
  }).join('');
}

function blockText(runs: Inline[]): string {
  // Apply block-context protection after joining runs: an ordinal and its
  // punctuation may come from different editor spans. Generated list/heading
  // markers and table separators are added only after this literal-text step.
  return runsToMarkdown(runs)
    .replace(/^( {0,3}\d{1,9})([.)])(?=\s|$)/gm, '$1\\$2')
    .replace(/^( {0,3})([-+=])/gm, '$1\\$2');
}
function blockMarkdown(block: DocumentBlock): string {
  const text = blockText(block.runs);
  switch (block.kind) {
    case 'heading': return `${'#'.repeat(block.level || 1)} ${text}`;
    case 'list': return text;
    case 'quote': return text.split('\n').map(line => `> ${line}`).join('\n');
    case 'code': { const fence = '`'.repeat(Math.max(3, ...(plainText(block.runs).match(/`+/g) || []).map(s => s.length + 1))); return `${fence}\n${plainText(block.runs)}\n${fence}`; }
    case 'table': {
      const rows = block.rows || [];
      if (!rows.length) return '';
      const count = Math.max(...rows.map(row => row.length));
      const row = (cells: Inline[][]) => `| ${Array.from({ length: count }, (_, i) => runsToMarkdown(cells[i] || []).replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ')} |`;
      return [row(rows[0]), `| ${Array(count).fill('---').join(' | ')} |`, ...rows.slice(1).map(row)].join('\n');
    }
    default: return text;
  }
}
export function renderMarkdown(document: MeetingDocument): Uint8Array {
  // Child blocks align under the ancestor's content, not a fixed two spaces:
  // `1. ` needs 3 columns and `12. ` needs 4. Non-list blocks one depth below
  // an item are its continuation paragraphs/tables and share that indentation.
  const ancestorWidths: number[] = [];
  const blocks = document.blocks.map(block => {
    const depth = block.depth || 0;
    const indent = ancestorWidths.slice(0, depth).reduce((sum, width) => sum + width, 0);
    const text = blockMarkdown(block);
    if (block.kind === 'list') {
      const marker = block.marker === '•' ? '-' : /^\[[ x]\]$/i.test(block.marker || '') ? `- ${block.marker}` : block.marker || '-';
      ancestorWidths.length = depth;
      const width = marker.startsWith('- [') ? 2 : marker.length + 1;
      ancestorWidths[depth] = width;
      return text.split('\n').map((line, index) => `${' '.repeat(indent)}${index ? ' '.repeat(width) : `${marker} `}${line}`).join('\n');
    }
    ancestorWidths.length = Math.min(ancestorWidths.length, depth);
    return text.split('\n').map(line => ' '.repeat(indent) + line).join('\n');
  });
  const sections = [`# ${document.title}`, `Date: ${document.date}`, ...blocks];
  if (document.warnings.length) sections.push('## Export notes', ...document.warnings.map(w => `- ${w}`));
  return new TextEncoder().encode(sections.join('\n\n') + '\n');
}
