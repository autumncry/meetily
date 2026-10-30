import { DocumentBlock, Inline, MeetingDocument, plainText } from './model';

function runsToMarkdown(runs: Inline[]): string {
  return runs.map(r => {
    if (!r.text.trim()) return r.text;
    const leading = r.text.match(/^\s*/)?.[0] || '';
    const trailing = r.text.trim() ? r.text.match(/\s*$/)?.[0] || '' : '';
    let text = r.text.trim().replace(/([\\`*_\[\]<>])/g, '\\$1');
    if (r.code) text = '`' + r.text.trim().replace(/`/g, '\\`') + '`';
    if (r.bold) text = `**${text}**`;
    if (r.italic) text = `*${text}*`;
    if (r.strike) text = `~~${text}~~`;
    if (r.href) text = `[${text}](${r.href.replace(/[()\s]/g, c => encodeURIComponent(c))})`;
    return leading + text + trailing;
  }).join('');
}
function blockMarkdown(block: DocumentBlock): string {
  const text = runsToMarkdown(block.runs);
  switch (block.kind) {
    case 'heading': return `${'#'.repeat(block.level || 1)} ${text}`;
    case 'list': return `${'  '.repeat(block.depth || 0)}${block.marker === '•' ? '-' : block.marker} ${text}`;
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
  const sections = [`# ${document.title}`, `Date: ${document.date}`, ...document.blocks.map(blockMarkdown)];
  if (document.warnings.length) sections.push('## Export notes', ...document.warnings.map(w => `- ${w}`));
  return new TextEncoder().encode(sections.join('\n\n') + '\n');
}
