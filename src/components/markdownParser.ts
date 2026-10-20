import MarkdownIt from 'markdown-it';

export type MarkdownNode = {
  type: string;
  tag: string;
  content: string;
  attrs: Record<string, string>;
  children: MarkdownNode[];
  info: string;
};

const parser = new MarkdownIt({html: false, linkify: true, breaks: true, typographer: false});
// Math is tokenized before escape/text rules, so Markdown punctuation in a
// formula is not mistaken for emphasis, escapes or a list. Code remains literal.
parser.inline.ruler.before('escape', 'conversation_math', (state, silent) => {
  const start = state.pos;
  const opening = ['\\(', '\\[', '$$', '$'].find(marker => state.src.startsWith(marker, start));
  if (!opening) return false;
  if (start > 0 && state.src[start - 1] === '\\') return false;
  const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
  if (opening === '$' && /\s/.test(state.src[start + 1] || ' ')) return false;
  let end = state.src.indexOf(closing, start + opening.length);
  while (end >= 0 && state.src[end - 1] === '\\') end = state.src.indexOf(closing, end + closing.length);
  if (end <= start + opening.length || end >= state.posMax) return false;
  const body = state.src.slice(start + opening.length, end);
  if (opening === '$' && (/\s$/.test(body) || /^\d/.test(state.src[end + 1] || ''))) return false;
  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.content = `${opening}${body}${closing}`;
  }
  state.pos = end + closing.length;
  return true;
});
parser.block.ruler.before('fence', 'conversation_math_block', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const first = state.src.slice(start, state.eMarks[startLine]).trim();
  const opening = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : '';
  if (!opening) return false;
  const closing = opening === '$$' ? '$$' : '\\]';
  let last = startLine;
  let end = first.indexOf(closing, opening.length);
  while (end < 0 && last + 1 < endLine) {
    last += 1;
    const line = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]).trim();
    end = line.indexOf(closing);
  }
  if (end < 0) return false;
  const lastText = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]).trim();
  if (lastText.slice(end + closing.length).trim()) return false;
  if (silent) return true;
  const token = state.push('math_block', '', 0);
  token.block = true;
  token.content = state.getLines(startLine, last + 1, state.blkIndent, false).trim();
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}, {alt: ['paragraph', 'reference', 'blockquote', 'list']});

function tree(tokens: ReturnType<typeof parser.parse>): MarkdownNode[] {
  const output: MarkdownNode[] = [];
  const stack = [output];
  for (const token of tokens) {
    if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
    const node: MarkdownNode = {
      type: token.type.replace(/_open$/, ''), tag: token.tag,
      content: token.content, info: token.info,
      attrs: Object.fromEntries((token.attrs || []).map(([key, value]) => [key, String(value)])),
      children: token.children ? tree(token.children) : [],
    };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return output;
}

export function parseMarkdown(value: string): MarkdownNode[] {
  return tree(parser.parse(String(value || ''), {}));
}

export function markdownCodeRanges(value: string): Array<{start: number; end: number}> {
  const offsets = [0];
  for (let i = 0; i < value.length; i += 1) if (value[i] === '\n') offsets.push(i + 1);
  const ranges: Array<{start: number; end: number}> = [];
  for (const token of parser.parse(value, {})) {
    if (!['fence', 'code_block'].includes(token.type) || !token.map) continue;
    ranges.push({start: offsets[token.map[0]], end: offsets[token.map[1]] ?? value.length});
  }
  // Code spans may use multiple backticks and contain newlines. These are only
  // protection ranges; markdown-it remains the authority for actual rendering.
  for (const match of value.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    const start = match.index || 0;
    if (!ranges.some(range => range.start <= start && start < range.end)) ranges.push({start, end: start + match[0].length});
  }
  return ranges.sort((a, b) => a.start - b.start);
}


export function safeMarkdownLink(value: string): string {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.toString() : '';
  } catch { return ''; }
}
