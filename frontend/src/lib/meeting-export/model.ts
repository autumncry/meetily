import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export type ExportFormat = 'md' | 'docx' | 'pdf';
export type ExportContent = 'summary' | 'transcript' | 'both';
export interface Inline { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; href?: string }
export interface DocumentBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'quote' | 'code';
  runs: Inline[];
  level?: number;
  depth?: number;
  marker?: string;
  rows?: Inline[][][];
}
export interface MeetingDocument { title: string; date: string; content: ExportContent; blocks: DocumentBlock[]; warnings: string[] }
export interface ExportTranscript { id?: string; text: string; timestamp?: string; audio_start_time?: number; sequence_id?: number; chunk_start_time?: number }
export interface MeetingDocumentInput { title: string; date: string; content: ExportContent; summary?: unknown; transcripts?: ExportTranscript[] }

// External editor/legacy JSON is checked at this boundary, rather than cast to a
// particular editor schema that would silently discard unfamiliar content.
type Node = Record<string, any>;
const object = (value: unknown): Node => value && typeof value === 'object' ? value as Node : {};
const textRun = (text: string): Inline[] => [{ text }];
export const plainText = (runs: Inline[]) => runs.map(r => r.text).join('');

function blockInline(value: unknown): Inline[] {
  if (value == null || typeof value !== 'object' && typeof value !== 'string') return [];
  if (typeof value === 'string') return textRun(value);
  if (Array.isArray(value)) return value.flatMap(blockInline);
  const n = object(value);
  if (typeof n.text === 'string') return [{ text: n.text, ...n.styles }];
  const runs = blockInline(n.content);
  if (n.type === 'link') return runs.map(r => ({ ...r, href: n.href }));
  if (n.type === 'hardBreak') return textRun('\n');
  return runs;
}

function imagePlaceholder(n: Node, warnings: string[]): Inline[] {
  const caption = n.props?.caption || n.alt || n.props?.name || '';
  const url = n.props?.url || n.url || '';
  warnings.push('Images are represented by captions and source URLs; image files are not embedded.');
  return textRun(`[Image not embedded${caption ? `: ${caption}` : ''}${url ? ` — ${url}` : ''}]`);
}

function blockNoteBlocks(values: unknown[], warnings: string[], depth = 0): DocumentBlock[] {
  let ordered = 0;
  return values.flatMap(value => {
    const n = object(value);
    const runs = blockInline(n.content);
    let block: DocumentBlock = { kind: 'paragraph', runs, depth };
    switch (n.type) {
      case 'heading': block = { ...block, kind: 'heading', level: Math.min(6, Math.max(1, Number(n.props?.level) || 1)) }; break;
      case 'bulletListItem': ordered = 0; block = { ...block, kind: 'list', marker: '•' }; break;
      case 'numberedListItem': ordered = Number(n.props?.start) || ordered + 1; block = { ...block, kind: 'list', marker: `${ordered}.` }; break;
      case 'checkListItem': block = { ...block, kind: 'list', marker: n.props?.checked ? '[x]' : '[ ]' }; break;
      case 'table': block = { ...block, kind: 'table', rows: (n.content?.rows || []).map((r: Node) => (r.cells || []).map((cell: unknown) => blockInline(object(cell).content ?? cell))) }; break;
      case 'codeBlock': block = { ...block, kind: 'code' }; break;
      case 'quote': block = { ...block, kind: 'quote' }; break;
      case 'image': block.runs = [...imagePlaceholder(n, warnings), ...textRun('\n'), ...runs]; break;
      case 'paragraph': break;
      default:
        if (n.type) {
          warnings.push(`Unsupported block type "${n.type}" exported as text.`);
          block.runs = [...textRun(`[${n.type}] `), ...runs];
          if (n.props?.caption) block.runs.push(...textRun(String(n.props.caption)));
        }
    }
    return [block, ...(Array.isArray(n.children) ? blockNoteBlocks(n.children, warnings, depth + 1) : [])];
  });
}

function markdownBlocks(markdown: string, warnings: string[]): DocumentBlock[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const inline = (node: Node, style: Partial<Inline> = {}): Inline[] => {
    if (node.type === 'image') return imagePlaceholder(node, warnings);
    if (node.type === 'break') return [{ text: '\n', ...style }];
    if (typeof node.value === 'string') return [{ text: node.value, ...style, ...(node.type === 'inlineCode' ? { code: true } : {}) }];
    const next = { ...style, ...(node.type === 'strong' ? { bold: true } : {}), ...(node.type === 'emphasis' ? { italic: true } : {}), ...(node.type === 'delete' ? { strike: true } : {}), ...(node.type === 'link' ? { href: node.url } : {}) };
    return (node.children || []).flatMap((c: Node) => inline(c, next));
  };
  const visit = (nodes: Node[], depth = 0): DocumentBlock[] => nodes.flatMap(n => {
    if (n.type === 'list') return (n.children || []).flatMap((item: Node, index: number) => {
      const children = visit(item.children || [], depth + 1);
      if (!children.length) return [];
      children[0] = { ...children[0], kind: 'list', depth, marker: item.checked != null ? (item.checked ? '[x]' : '[ ]') : n.ordered ? `${(n.start || 1) + index}.` : '•' };
      return children;
    });
    if (n.type === 'blockquote') return visit(n.children || [], depth).map(b => ({ ...b, kind: b.kind === 'paragraph' ? 'quote' as const : b.kind }));
    if (n.type === 'table') return [{ kind: 'table', runs: [], rows: (n.children || []).map((row: Node) => (row.children || []).map((cell: Node) => inline(cell))) }];
    if (n.type === 'thematicBreak') return [{ kind: 'paragraph', runs: textRun('────────') }];
    if (n.type === 'definition') return [];
    return [{ kind: n.type === 'heading' ? 'heading' : n.type === 'code' ? 'code' : 'paragraph', level: n.depth, depth, runs: inline(n) } as DocumentBlock];
  });
  return visit(tree.children as Node[]);
}

function summaryBlocks(value: unknown, warnings: string[]): DocumentBlock[] {
  if (typeof value === 'string') return markdownBlocks(value, warnings);
  const summary = object(value);
  if (Array.isArray(summary.summary_json)) return blockNoteBlocks(summary.summary_json, warnings);
  if (typeof summary.markdown === 'string') return markdownBlocks(summary.markdown, warnings);
  const keys = [...new Set([...(Array.isArray(summary._section_order) ? summary._section_order : []), ...Object.keys(summary)])];
  return keys.flatMap(key => {
    const section = object(summary[key]);
    if (!Array.isArray(section.blocks)) return [];
    return [
      { kind: 'heading', level: 2, runs: textRun(String(section.title || key)) } as DocumentBlock,
      ...section.blocks.map((b: Node): DocumentBlock => {
        const runs = blockInline(b.content);
        if (b.type === 'heading1' || b.type === 'heading2') return { kind: 'heading', level: b.type === 'heading1' ? 1 : 2, runs };
        if (['bullet', 'bulletListItem', 'list'].includes(b.type)) return { kind: 'list', marker: '•', runs };
        return { kind: 'paragraph', runs };
      }),
    ];
  });
}

export function formatTimestamp(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function safeFilename(title: string, format: ExportFormat) {
  const safe = title.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  // Bound by UTF-8 bytes for macOS file-name limits, without splitting Unicode.
  let stem = '';
  for (const char of safe || 'Meeting') {
    if (new TextEncoder().encode(stem + char).length > 180) break;
    stem += char;
  }
  return `${stem}.${format}`;
}

export function buildMeetingDocument(input: MeetingDocumentInput): MeetingDocument {
  const warnings: string[] = [];
  const blocks: DocumentBlock[] = [];
  if (input.content !== 'transcript') {
    const summary = summaryBlocks(input.summary, warnings);
    if (!summary.some(b => plainText(b.runs).trim() || b.rows?.some(r => r.some(c => plainText(c).trim())))) throw new Error('No summary content to export.');
    blocks.push({ kind: 'heading', level: 1, runs: textRun('Summary') }, ...summary);
  }
  if (input.content !== 'summary') {
    const transcripts = (input.transcripts || []).filter(t => t.text.trim()).map((t, index) => ({ t, index }));
    if (!transcripts.length) throw new Error('No transcript content to export.');
    transcripts.sort((a, b) => (a.t.audio_start_time ?? a.t.chunk_start_time ?? a.t.sequence_id ?? a.index) - (b.t.audio_start_time ?? b.t.chunk_start_time ?? b.t.sequence_id ?? b.index) || a.index - b.index);
    blocks.push({ kind: 'heading', level: 1, runs: textRun('Transcript') });
    for (const { t } of transcripts) {
      const seconds = t.audio_start_time ?? t.chunk_start_time;
      const timestamp = seconds != null && Number.isFinite(seconds) ? formatTimestamp(seconds) : t.timestamp;
      blocks.push({ kind: 'paragraph', runs: [{ text: timestamp ? `[${timestamp}] ` : '', bold: true }, { text: t.text }] });
    }
  }
  return { title: input.title || 'Meeting', date: input.date, content: input.content, blocks, warnings: [...new Set(warnings)] };
}
