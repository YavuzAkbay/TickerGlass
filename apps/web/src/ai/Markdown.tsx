/**
 * Minimal Markdown for model answers: paragraphs, headings, lists, quotes, code, simple tables,
 * bold / italic / inline code. Builds React elements only (no HTML injection); anything it
 * does not understand stays as plain text.
 */
import type { ReactNode } from 'react';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;

export function inline(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}i${i++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**') || tok.startsWith('__'))
      out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p' | 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'hr' };

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) body.push(lines[i++]!);
      i++; // closing fence (or end of a still-streaming answer)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ kind: 'h', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (trimmed.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const row = lines[i++]!;
        if (!/^\s*\|?\s*:?-{2,}/.test(row)) rows.push(cells(row));
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const listKind = /^[-*+]\s+/.test(trimmed) ? 'ul' : /^\d+[.)]\s+/.test(trimmed) ? 'ol' : null;
    if (listKind) {
      const items: string[] = [];
      const marker = listKind === 'ul' ? /^[-*+]\s+/ : /^\d+[.)]\s+/;
      while (i < lines.length) {
        const t = lines[i]!.trim();
        if (marker.test(t)) items.push(t.replace(marker, ''));
        else if (t && items.length && /^\s{2,}/.test(lines[i]!))
          items[items.length - 1] += ` ${t}`; // continuation line
        else break;
        i++;
      }
      blocks.push({ kind: listKind, items });
      continue;
    }
    const quote = trimmed.startsWith('>');
    const para: string[] = [];
    while (i < lines.length) {
      const t = lines[i]!.trim();
      if (!t || t.startsWith('```') || t.startsWith('|') || /^#{1,6}\s/.test(t)) break;
      if (!quote && (/^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t))) break;
      if (quote !== t.startsWith('>')) break;
      para.push(quote ? t.replace(/^>\s?/, '') : t);
      i++;
    }
    blocks.push({ kind: quote ? 'quote' : 'p', lines: para });
  }
  return blocks;
}

function renderBlock(b: Block, k: string): ReactNode {
  switch (b.kind) {
    case 'p':
      return <p key={k}>{inline(b.lines.join(' '), k)}</p>;
    case 'quote':
      return <blockquote key={k}>{inline(b.lines.join(' '), k)}</blockquote>;
    case 'h':
      return b.level <= 2 ? (
        <h4 key={k}>{inline(b.text, k)}</h4>
      ) : (
        <h5 key={k}>{inline(b.text, k)}</h5>
      );
    case 'ul':
    case 'ol': {
      const items = b.items.map((it, j) => <li key={`${k}l${j}`}>{inline(it, `${k}l${j}`)}</li>);
      return b.kind === 'ul' ? <ul key={k}>{items}</ul> : <ol key={k}>{items}</ol>;
    }
    case 'code':
      return (
        <pre key={k}>
          <code>{b.text}</code>
        </pre>
      );
    case 'table': {
      const [head, ...body] = b.rows;
      return (
        <div className="ai-md-table" key={k}>
          <table>
            {head && (
              <thead>
                <tr>
                  {head.map((c, j) => (
                    <th key={j}>{inline(c, `${k}h${j}`)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${k}r${ri}c${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr key={k} />;
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="ai-md">{parseBlocks(text).map((b, i) => renderBlock(b, `b${i}`))}</div>;
}
