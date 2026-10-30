import { describe, expect, test } from 'bun:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { buildMeetingDocument, renderMeetingDocument } from '../../src/lib/meeting-export';
import { collectAllTranscripts, saveMeetingExport } from '../../src/lib/meeting-export/save';

const meeting = { title: '访谈 / 讨论: 😀', date: '2026-10-30T08:00:00+08:00' };
const transcripts = Array.from({ length: 240 }, (_, i) => ({ id: String(i), text: `中文片段 ${i} 😀`, timestamp: '08:00:00', audio_start_time: i * 10 }));

describe('meeting exports', () => {
  test.each([
    '1. Parent\n   1. Child\n   2. Child two\n2. Parent two',
    '12. Parent\n\n    3. Child\n       - Mixed child\n    4. Child two\n13. Parent two',
    '- Parent\n\n  10. Ordered child\n      - Bullet grandchild\n  11. Ordered two\n- Parent two',
    '1. Parent\n\n   Continuation paragraph\n\n   - Mixed child\n\n     Child continuation\n\n2. Parent two',
  ])('Markdown retains GFM list hierarchy on AST round-trip: %s', async markdown => {
    const parse = (text: string) => unified().use(remarkParse).use(remarkGfm).parse(text);
    // Compare semantic list structure, starts and actual paragraph text, rather
    // than source whitespace or parser position/spread formatting metadata.
    const shape = (node: any): any => ({ type: node.type, ...(node.type === 'list' ? { ordered: node.ordered, start: node.start } : {}), ...(node.type === 'text' ? { value: node.value } : {}), ...(node.children ? { children: node.children.map(shape) } : {}) });
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { markdown } });
    const exported = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    const actual = parse(exported).children.filter(n => n.type === 'list').map(shape);
    const expected = parse(markdown).children.filter(n => n.type === 'list').map(shape);
    expect(actual).toEqual(expected);
  });
  test('structured numbered lists restart after every non-numbered sibling in all adapters', async () => {
    const numbered = (text: string) => ({ type: 'numberedListItem', content: [{ text }] });
    const separators = [
      { type: 'heading', props: { level: 2 }, content: [{ text: 'Separator heading' }] },
      { type: 'paragraph', content: [{ text: 'Separator paragraph' }] },
      { type: 'checkListItem', props: { checked: true }, content: [{ text: 'Separator checklist' }] },
      { type: 'table', content: { rows: [{ cells: [[{ text: 'Separator table' }]] }] } },
    ];
    const blocks = ['A', 'B', 'C', 'D', 'E'].flatMap((group, index) => [
      ...(index ? [separators[index - 1]] : []), numbered(`Group ${group} one`), numbered(`Group ${group} two`),
    ]);
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { summary_json: blocks } });
    expect(document.blocks.filter(b => /^\d+\.$/.test(b.marker || '')).map(b => b.marker)).toEqual(['1.', '2.', '1.', '2.', '1.', '2.', '1.', '2.', '1.', '2.']);
    const markdown = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    const ast = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    expect(ast.children.flatMap(n => n.type === 'list' && n.ordered ? [n.start] : [])).toEqual([1, 1, 1, 1, 1]);

    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    const options = { fonts: { cjk: fonts[0], emoji: fonts[1] } };
    const zip = await JSZip.loadAsync((await renderMeetingDocument(document, 'docx', options)).bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    const ids = paragraphs.filter(p => /Group [A-E] (one|two)/.test(p)).map(p => /<w:numId w:val="(\d+)"/.exec(p)![1]);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(5);
    for (let i = 0; i < ids.length; i += 2) {
      expect(ids[i]).toBe(ids[i + 1]);
      const abstractId = new RegExp(`<w:num w:numId="${ids[i]}"><w:abstractNumId w:val="(\\d+)"`).exec(numbering)![1];
      const definition = new RegExp(`<w:abstractNum w:abstractNumId="${abstractId}"[\\s\\S]*?</w:abstractNum>`).exec(numbering)![0];
      expect(definition).toMatch(/<w:lvl w:ilvl="0"[^>]*><w:start w:val="1"/);
    }
    if (Bun.which('pdftotext')) {
      const directory = await mkdtemp(join(tmpdir(), 'meetily-list-reset-'));
      try {
        const path = join(directory, 'lists.pdf');
        await writeFile(path, (await renderMeetingDocument(document, 'pdf', options)).bytes);
        const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
        expect([...text.matchAll(/([12])\.\s+Group ([A-E]) (one|two)/g)].map(m => m.slice(1))).toEqual([
          ['1', 'A', 'one'], ['2', 'A', 'two'], ['1', 'B', 'one'], ['2', 'B', 'two'], ['1', 'C', 'one'],
          ['2', 'C', 'two'], ['1', 'D', 'one'], ['2', 'D', 'two'], ['1', 'E', 'one'], ['2', 'E', 'two'],
        ]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 60000);

  test('structured numbered lists retain explicit starts and independent nested counters', async () => {
    const item = (text: string, start?: number, children?: unknown[]) => ({ type: 'numberedListItem', props: { start }, content: [{ text }], children });
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { summary_json: [
      item('Parent seven', 7, [item('Child three', 3), item('Child four'), { type: 'paragraph', content: 'Child separator' }, item('Child one'), item('Child two')]),
      item('Parent eight', undefined, [item('Fresh child one'), item('Fresh child two')]),
      item('Explicit restart', 1), item('After restart'),
    ] } });
    expect(document.blocks.filter(b => b.kind === 'list').map(b => [b.depth, b.marker])).toEqual([
      [0, '7.'], [1, '3.'], [1, '4.'], [1, '1.'], [1, '2.'], [0, '8.'], [1, '1.'], [1, '2.'], [0, '1.'], [0, '2.'],
    ]);
  });

  test.each([
    '# literal heading marker', '10. literal paragraph', '10) literal paragraph', '- literal bullet', '+ literal bullet',
    '---', 'Text\n===', 'Text\n# literal second line', '~~literal tildes~~', '`literal backticks`',
    'A | B\n--- | ---\nC | D', 'literal &copy; entity',
  ])('Markdown preserves structured literal paragraph text on AST round-trip: %s', async value => {
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { summary_json: [{ type: 'paragraph', content: [{ text: value }] }] } });
    const markdown = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    const nodes = unified().use(remarkParse).use(remarkGfm).parse(markdown).children.slice(3);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('paragraph');
    expect((nodes[0] as any).children.map((n: any) => ({ type: n.type, value: n.value }))).toEqual([{ type: 'text', value }]);
  });

  test.each(['a`b', '`edge', 'edge`', '``', 'a``b```c', ' padded ', '  ', ' ordinary', 'trailing '])('Markdown preserves inline code delimiters and spaces on AST round-trip: %s', async value => {
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { summary_json: [{ type: 'paragraph', content: [{ text: 'Code: ' }, { text: value, styles: { code: true } }] }] } });
    const markdown = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    const nodes = unified().use(remarkParse).use(remarkGfm).parse(markdown).children.slice(3);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('paragraph');
    expect((nodes[0] as any).children.map((n: any) => ({ type: n.type, value: n.value }))).toEqual([{ type: 'text', value: 'Code: ' }, { type: 'inlineCode', value }]);
  });

  test('Markdown normalizes code-span line endings without escaping their literal block markers', async () => {
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { summary_json: [
      { type: 'paragraph', content: [{ text: 'Code: ' }, { text: 'a\n- b\r\n10. c', styles: { code: true } }] },
    ] } });
    const markdown = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    const paragraph: any = unified().use(remarkParse).use(remarkGfm).parse(markdown).children.at(-1);
    expect(paragraph.type).toBe('paragraph');
    expect(paragraph.children.map((n: any) => ({ type: n.type, value: n.value }))).toEqual([
      { type: 'text', value: 'Code: ' }, { type: 'inlineCode', value: 'a - b 10. c' },
    ]);
  });

  test('Markdown AST input retains literal text alongside real links, styles, tables and nested lists', async () => {
    const markdown = [
      '\\# literal heading', '', '10\\. literal paragraph with \\~\\~tildes\\~\\~', '',
      '## Real heading', '', '3. **Bold** and [link](https://example.invalid/path)',
      '   - ~~Strike~~ and ``a`b``', '4. Last item', '',
      '| Header | Code |', '| --- | --- |', '| Literal \\| pipe | ``a`b\\|c`` |',
    ].join('\n');
    const parse = (value: string) => unified().use(remarkParse).use(remarkGfm).parse(value);
    const shape = (node: any): any => ({
      type: node.type,
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(node.depth !== undefined ? { depth: node.depth } : {}),
      ...(node.url !== undefined ? { url: node.url } : {}),
      ...(node.type === 'list' ? { ordered: node.ordered, start: node.start } : {}),
      ...(node.children ? { children: node.children.map(shape) } : {}),
    });
    const document = buildMeetingDocument({ ...meeting, content: 'summary', summary: { markdown } });
    const exported = new TextDecoder().decode((await renderMeetingDocument(document, 'md')).bytes);
    expect(parse(exported).children.slice(3).map(shape)).toEqual(parse(markdown).children.map(shape));
  });

  test('retains every ordered transcript, Unicode, title and recording timestamps', async () => {
    const doc = buildMeetingDocument({ ...meeting, transcripts: [...transcripts].reverse(), content: 'transcript' });
    const out = await renderMeetingDocument(doc, 'md');
    const text = new TextDecoder().decode(out.bytes);
    expect(text).toContain(meeting.title);
    expect(text).toContain(meeting.date);
    expect(doc.blocks.at(-1)?.runs.map(run => run.text).join('')).toBe('[00:39:50] 中文片段 239 😀');
    expect(text).toContain('00:39:50');
    expect(text).toContain('中文片段 239 😀');
    expect(text.indexOf('片段 0 ')).toBeLessThan(text.indexOf('片段 239 '));
    expect(out.filename).not.toMatch(/[/:]/);
    expect(out.filename.endsWith('.md')).toBe(true);
  });

  test('structured live blocks take precedence and retain heading/list/table/image text', async () => {
    const doc = buildMeetingDocument({ ...meeting, content: 'summary', summary: { markdown: 'stale', summary_json: [
      { type: 'heading', props: { level: 2 }, content: [{ text: '最新编辑' }] },
      { type: 'bulletListItem', content: [{ text: '列表内容' }], children: [{ type: 'paragraph', content: [{ text: '嵌套内容' }] }] },
      { type: 'table', content: { rows: [{ cells: [[{ text: '表头' }], [{ text: '数值' }]] }, { cells: [[{ text: '北京' }], [{ text: '42' }]] }] } },
      { type: 'image', props: { url: 'https://example.invalid/image.png', caption: '原图说明' }, content: [{ text: '图片附近文字' }] },
    ] } });
    const text = new TextDecoder().decode((await renderMeetingDocument(doc, 'md')).bytes);
    expect(text).toContain('## 最新编辑');
    for (const s of ['列表内容', '嵌套内容', '| 表头 | 数值 |', '原图说明', '图片附近文字', 'Image not embedded']) expect(text).toContain(s);
    expect(text).not.toContain('stale');
  });

  test('parses Markdown structure and ordered legacy sections', async () => {
    const md = buildMeetingDocument({ ...meeting, content: 'summary', summary: { markdown: '# 标题\n\n1. 项目\n\n| A | B |\n| - | - |\n| 中 | 文 |' } });
    expect(md.blocks.some(b => b.kind === 'table')).toBe(true);
    const legacy = buildMeetingDocument({ ...meeting, content: 'summary', summary: { _section_order: ['b', 'a'], a: { title: '第二', blocks: [{ type: 'bullet', content: '尾部' }] }, b: { title: '第一', blocks: [{ type: 'paragraph', content: '开头' }] } } });
    const text = new TextDecoder().decode((await renderMeetingDocument(legacy, 'md')).bytes);
    expect(text.indexOf('第一')).toBeLessThan(text.indexOf('第二'));
  });

  test('rejects empty selected content rather than exporting an empty document', () => {
    expect(() => buildMeetingDocument({ ...meeting, content: 'summary', transcripts })).toThrow('summary');
    expect(() => buildMeetingDocument({ ...meeting, content: 'transcript', transcripts: [] })).toThrow('transcript');
    expect(() => buildMeetingDocument({ ...meeting, content: 'both', transcripts })).toThrow('summary');
  });

  test('legacy editor headings remain headings and literal text is not reinterpreted as Markdown', () => {
    const doc = buildMeetingDocument({ ...meeting, content: 'summary', summary: { notes: { title: 'Notes', blocks: [
      { type: 'heading1', content: '第一标题' }, { type: 'heading2', content: '第二标题' }, { type: 'text', content: '*literal* and #1' },
    ] } } });
    expect(doc.blocks.find(b => b.runs[0]?.text === '第一标题')?.level).toBe(1);
    expect(doc.blocks.find(b => b.runs[0]?.text === '第二标题')?.kind).toBe('heading');
    expect(doc.blocks.at(-1)?.runs).toEqual([{ text: '*literal* and #1' }]);
  });

  test('a transcript without timestamps has no empty formatting markers', async () => {
    const doc = buildMeetingDocument({ ...meeting, content: 'transcript', transcripts: [{ text: 'No timestamp available' }] });
    const text = new TextDecoder().decode((await renderMeetingDocument(doc, 'md')).bytes);
    expect(text).toContain('\n\nNo timestamp available\n');
    expect(text).not.toContain('****');
  });

  test('reads all pages and refuses incomplete pagination', async () => {
    const all = await collectAllTranscripts(async offset => ({ transcripts: transcripts.slice(offset, offset + 100), has_more: offset + 100 < 240, total_count: 240 }));
    expect(all).toHaveLength(240);
    await expect(collectAllTranscripts(async () => ({ transcripts: [], has_more: true, total_count: 3 }))).rejects.toThrow();
  });

  test('cancelled save performs no render or write; write errors propagate', async () => {
    let rendered = false;
    let written = false;
    const render = async () => { rendered = true; return new Uint8Array([1]); };
    expect(await saveMeetingExport({ filename: 'meeting.md', format: 'md', choosePath: async () => null, render, write: async () => { written = true; } })).toBe('cancelled');
    expect(rendered).toBe(false);
    expect(written).toBe(false);
    await expect(saveMeetingExport({ filename: 'meeting.md', format: 'md', choosePath: async () => '/tmp/meeting.md', render, write: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
  });

  test('real DOCX is editable XML and real PDF embeds fonts with multiple pages', async () => {
    const doc = buildMeetingDocument({ ...meeting, content: 'transcript', transcripts });
    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf', 'NotoSansJP-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    const options = { fonts: { cjk: fonts[0], emoji: fonts[1], hanFallback: fonts[2] } };
    const word = await renderMeetingDocument(doc, 'docx', options);
    expect([...word.bytes.slice(0, 2)]).toEqual([80, 75]);
    const zip = await JSZip.loadAsync(word.bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('中文片段 239 ');
    expect(xml).toContain('😀');
    expect((xml.match(/中文片段 /g) || [])).toHaveLength(240);
    expect(Object.keys(zip.files).filter(name => name.endsWith('.odttf'))).toHaveLength(2);
    const pdf = await renderMeetingDocument(doc, 'pdf', options);
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 8))).toContain('%PDF-');
    expect(pdf.bytes.length).toBeLessThan(2_000_000);
    const { PDFDocument } = await import('pdf-lib');
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBeGreaterThan(3);
  }, 60000);

  test('DOCX uses native list numbering with source starts and nesting', async () => {
    const doc = buildMeetingDocument({ ...meeting, content: 'summary', summary: { markdown: '3. Third\n4. Fourth\n   1. Nested\n\n- Bullet' } });
    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    const result = await renderMeetingDocument(doc, 'docx', { fonts: { cjk: fonts[0], emoji: fonts[1] } });
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect((xml.match(/<w:numPr>/g) || [])).toHaveLength(4);
    const numbering = await zip.file('word/numbering.xml')!.async('string');
    expect(numbering).toContain('w:start w:val="3"');
    expect(numbering).toContain('w:numFmt w:val="bullet"');
    expect(xml).toContain('w:ilvl w:val="1"');
  }, 60000);

  test.skipIf(!Bun.which('pdftotext'))('PDF never leaves a timestamp/speaker line alone at a page boundary', async () => {
    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    // Header + section consume 117.075 points. Twenty-five one-line transcript
    // paragraphs leave room for one line, but not two, on the first page.
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, audio_start_time: i, text: 'Filler line' }));
    rows.push({ id: 'boundary', audio_start_time: 100, text: 'SPEAKER_LABEL\nFIRST_BODY_LINE' });
    const doc = buildMeetingDocument({ ...meeting, content: 'transcript', transcripts: rows });
    const result = await renderMeetingDocument(doc, 'pdf', { fonts: { cjk: fonts[0], emoji: fonts[1] } });
    const directory = await mkdtemp(join(tmpdir(), 'meetily-export-test-'));
    try {
      const path = join(directory, 'boundary.pdf');
      await writeFile(path, result.bytes);
      const pages = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' }).split('\f');
      const page = pages.find(text => text.includes('SPEAKER_LABEL'));
      expect(page).toBeDefined();
      expect(page).toContain('FIRST_BODY_LINE');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60000);

  test.skipIf(!Bun.which('pdftotext'))('PDF preserves rare Han names in its searchable Unicode text', async () => {
    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf', 'NotoSansJP-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    const document = buildMeetingDocument({ ...meeting, title: '𠮷中', content: 'transcript', transcripts: [{ text: '参会人：𠮷田', audio_start_time: 0 }] });
    const result = await renderMeetingDocument(document, 'pdf', { fonts: { cjk: fonts[0], emoji: fonts[1], hanFallback: fonts[2] } });
    const directory = await mkdtemp(join(tmpdir(), 'meetily-rare-han-test-'));
    try {
      const path = join(directory, 'rare-han.pdf');
      await writeFile(path, result.bytes);
      const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
      expect(text).toContain('𠮷田');
      expect(text).not.toContain('[U+20BB7]');
      if (Bun.which('pdftoppm')) {
        // Correct ToUnicode mappings alone can conceal an invisible subset
        // font. At 72 dpi these are the two 20-point title-glyph boxes. Require
        // visible ink for BOTH the rare fallback glyph and the ordinary CJK
        // glyph next to it, without depending on an exact anti-aliasing image.
        const ppm = execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-singlefile', path], { maxBuffer: 4_000_000 });
        const header = /^P6\n(\d+) (\d+)\n255\n/.exec(ppm.subarray(0, 64).toString('ascii'))!;
        expect(header).not.toBeNull();
        const width = Number(header[1]), offset = header[0].length;
        const ink = (left: number, right: number) => {
          let count = 0;
          for (let y = 60; y < 85; y++) for (let x = left; x < right; x++) {
            const p = offset + (y * width + x) * 3;
            if (ppm[p] + ppm[p + 1] + ppm[p + 2] < 600) count++;
          }
          return count;
        };
        expect(ink(49, 67)).toBeGreaterThan(20);
        expect(ink(69, 87)).toBeGreaterThan(20);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60000);

  test('PDF rejects unsupported Unicode with a preserving-format alternative', async () => {
    const fonts = await Promise.all(['NotoSansSC-Regular.ttf', 'NotoEmoji-Regular.ttf', 'NotoSansJP-Regular.ttf'].map(n => readFile(new URL(`../../public/fonts/${n}`, import.meta.url))));
    const document = buildMeetingDocument({ ...meeting, content: 'transcript', transcripts: [{ text: 'Custom character \u{F0000}' }] });
    await expect(renderMeetingDocument(document, 'pdf', { fonts: { cjk: fonts[0], emoji: fonts[1], hanFallback: fonts[2] } })).rejects.toThrow(/PDF.*U\+F0000.*Markdown.*DOCX/);
  }, 60000);
});
