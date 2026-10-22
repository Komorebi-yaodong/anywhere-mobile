import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Linking, ScrollView, StyleSheet, Text} from 'react-native';
import {fitDisplayMath, NativeMarkdown} from '../src/components/NativeMarkdown';
import {parseMarkdown, safeMarkdownLink, type MarkdownNode} from '../src/components/markdownParser';
import {parseConversationContent} from '../src/components/conversationMediaMarkup';

import Clipboard from '@react-native-clipboard/clipboard';
import {MarkdownCodeBlock, codeTextChunks, CODE_VIEWPORT_MAX_HEIGHT} from '../src/components/MarkdownCodeBlock';
import {directoryTree, directoryMessage} from '../test-fixtures/directoryTree';

const flatten = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
async function render(value: string) {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<NativeMarkdown value={value} />); });
  return root;
}

it('keeps many-fence/table replies in one continuous unstyled content root and retains the ending', async () => {
  const source = Array.from({length: 32}, (_, i) => `## Section ${i}\n\n正文 ${i}\n\n\`\`\`text\nrow-${i}\n\`\`\`\n\n`).join('') + '| A | B |\n|---|---|\n| x | y |\n\n最后正文完整';
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<NativeMarkdown value={source} />);});
  const surfaces = root.root.findAll(node => node.props.testID === 'markdown-surface-segment' && node.props.style);
  expect(surfaces).toHaveLength(0);
  expect(root.root.findAllByType(MarkdownCodeBlock)).toHaveLength(32);
  const table = root.root.findAll(node => node.props.accessibilityLabel === 'Markdown 表格')[0];
  expect(StyleSheet.flatten(table.findByType(ScrollView).props.style)).toMatchObject({flexGrow: 0, flexShrink: 0});
  expect(JSON.stringify(root.toJSON())).toContain('最后正文完整');
  await act(async () => root.unmount());
});


it('keeps the supplied directory literal and bounds its native code viewport without losing following prose', async () => {
  expect(parseConversationContent(directoryMessage)).toEqual([{kind: 'text', value: directoryMessage}]);
  const fences = flatten(parseMarkdown(directoryMessage)).filter(node => node.type === 'fence');
  expect(fences).toHaveLength(1);
  expect(fences[0].content).toBe(directoryTree + '\n');
  const root = await render(directoryMessage + '\n\n代码块之后的正文仍可见');
  const block = root.root.findByType(MarkdownCodeBlock);
  expect(codeTextChunks(directoryTree).join('\n')).toBe(directoryTree);
  const codeNodes = block.findAllByType(Text).filter(node => StyleSheet.flatten(node.props.style)?.fontFamily === 'monospace');
  expect(codeNodes.map(node => node.props.children).join('\n')).toBe(directoryTree);
  expect(codeNodes.length).toBeGreaterThan(1);
  expect(codeNodes.every(node => node.props.allowFontScaling !== false)).toBe(true);
  const horizontal = block.findAllByType(ScrollView).find(node => node.props.horizontal)!;
  const vertical = block.findAllByType(ScrollView).find(node => !node.props.horizontal)!;
  for (const viewport of [horizontal, vertical]) {
    expect(StyleSheet.flatten(viewport.props.style)).toMatchObject({height: CODE_VIEWPORT_MAX_HEIGHT, flexGrow: 0, flexShrink: 0});
    expect(viewport.props.nestedScrollEnabled).toBe(true);
    expect(viewport.props.removeClippedSubviews).toBe(false);
  }
  expect(StyleSheet.flatten(horizontal.props.style).width).toBe('100%');
  await act(async () => block.findAll(node => node.props.accessibilityLabel === '复制完整代码' && node.props.onPress)[0].props.onPress());
  expect(Clipboard.setString).toHaveBeenLastCalledWith(directoryTree + '\n');
  expect(JSON.stringify(root.toJSON())).toContain('代码块之后的正文仍可见');
  await act(async () => root.unmount());
});

it('does not inflate short fences and preserves literal whitespace across code chunks', async () => {
  for (const value of ['', 'a\n\n', '\n' + 'row\n'.repeat(70), 'very wide '.repeat(800)]) expect(codeTextChunks(value).join('\n')).toBe(value);
  const root = await render('```text\nshort\n```');
  const horizontal = root.root.findAllByType(ScrollView).find(node => node.props.horizontal)!;
  expect(StyleSheet.flatten(horizontal.props.style).height).toBeLessThan(CODE_VIEWPORT_MAX_HEIGHT);
  await act(async () => root.unmount());
});


it('bounds large-font code without disabling system font scaling', async () => {
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({width: 320, height: 640, scale: 3, fontScale: 2.5});
  let root!: TestRenderer.ReactTestRenderer;
  try {
    root = await render('```text\n' + 'font-scaled line\n'.repeat(20) + '```');
    const horizontal = root.root.findAllByType(ScrollView).find(node => node.props.horizontal)!;
    expect(StyleSheet.flatten(horizontal.props.style).height).toBe(CODE_VIEWPORT_MAX_HEIGHT);
    expect(root.root.findAllByType(Text).every(node => node.props.allowFontScaling !== false)).toBe(true);
    expect(root.root.findAllByType(ScrollView).every(node => node.props.removeClippedSubviews === false)).toBe(true);
  } finally {await act(async () => root?.unmount()); dimensions.mockRestore();}
});


it('parses real Markdown table structure with alignment, escaped pipes and inline formats', () => {
  const nodes = flatten(parseMarkdown('| 名称 | 值 |\n| :--- | ---: |\n| **项目** | `a\\|b` |\n| 测试 | 42 |'));
  expect(nodes.filter(node => node.type === 'table')).toHaveLength(1);
  expect(nodes.filter(node => node.type === 'tr')).toHaveLength(3);
  expect(nodes.filter(node => node.type === 'th').map(node => node.attrs.style)).toEqual(['text-align:left', 'text-align:right']);
  expect(nodes.some(node => node.type === 'code_inline' && node.content === 'a|b')).toBe(true);
  expect(nodes.some(node => node.type === 'strong')).toBe(true);
});

it('measures horizontal table height instead of filling the vertical message viewport', async () => {
 const root = await render('| A | B |\n|---|---|\n| x | y |');
 const content = root.root.findAll(node => node.props.accessibilityLabel === '表格内容' && node.props.onLayout)[0];
 await act(async () => content.props.onLayout({nativeEvent: {layout: {height: 146.2}}}));
 const scroll = root.root.findByType(ScrollView);
 expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({height: 147, flexGrow: 0, flexShrink: 0});
 expect(scroll.props.removeClippedSubviews).toBe(false);
 await act(async () => root.unmount());
});


it('renders wide tables as horizontally scrollable, consistently sized native cells', async () => {
  const root = await render('| A | B | C | D |\n| --- | :---: | ---: | --- |\n| one | two | three | four |\n| five | six | seven | eight |');
  expect(root.root.findAll(node => node.props.accessibilityLabel === 'Markdown 表格').length).toBeGreaterThan(0);
  expect(root.root.findAllByType(ScrollView).some(node => node.props.horizontal)).toBe(true);
  const cells = root.root.findAll(node => ['表头', '单元格'].includes(node.props.accessibilityLabel) && node.props.style);
  expect(new Set(cells.map(node => StyleSheet.flatten(node.props.style).width)).size).toBe(1);
  expect(cells.length).toBeGreaterThanOrEqual(12);
  expect(root.root.findAllByType(Text).some(node => StyleSheet.flatten(node.props.style)?.textAlign === 'right')).toBe(true);
  await act(async () => root.unmount());
});

it('supports headings, nested lists, quotes, strike, emphasis, rules and code fences', async () => {
  const source = '# Title\n\n> Quote with *emphasis*\n\n3. first\n4. second\n   - nested **bold**\n\n~~removed~~\n\n---\n\n```html\n<img src="https://fixture.example/a.png">\n| not | table |\n```';
  const nodes = flatten(parseMarkdown(source));
  for (const type of ['heading', 'blockquote', 'em', 'ordered_list', 'bullet_list', 'strong', 's', 'hr', 'fence']) expect(nodes.some(node => node.type === type)).toBe(true);
  expect(nodes.filter(node => node.type === 'table')).toHaveLength(0);
  const root = await render(source);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '<img src="https://fixture.example/a.png">\n| not | table |')).toBe(true);
  await act(async () => root.unmount());
});

it('preserves formulas without treating code or literal currency as math', async () => {
  const source = '**Result** $x_1 + y$\n\n$$\na_b + c\n$$\n\n\\[\nx^2\n\\]\n\n`$code$` and $5 only';
  const nodes = flatten(parseMarkdown(source));
  expect(nodes.filter(node => node.type === 'math_inline')).toHaveLength(1);
  expect(nodes.filter(node => node.type === 'math_block')).toHaveLength(2);
  expect(nodes.some(node => node.type === 'code_inline' && node.content === '$code$')).toBe(true);
  const root = await render(source);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '**Result** $x_1 + y$')).toBe(true);
  await act(async () => root.unmount());
});

it('fits display formulas to the measured message width without shrinking short formulas', async () => {
  expect(fitDisplayMath({width: 100, height: 4}, 300)).toEqual({width: 296, height: 11.84, scale: 296 / 700});
  expect(fitDisplayMath({width: 10, height: 4}, 300)).toEqual({width: 70, height: 28, scale: 1});
  expect(fitDisplayMath({width: 10, height: 4}, 0)).toBeNull();
  const {MathRenderer} = require('react-native-latex-text');

  MathRenderer.Render.mockReset();
  MathRenderer.Render.mockImplementation((latex: string, done: (result: {svg: string; width: number; height: number}) => void) => {
    done({svg: `<svg data-latex="${latex}"/>`, width: latex.includes('Attention') ? 100 : 10, height: 4});
  });
  const root = await render('$$\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}(QK^T/\\sqrt{d_k})V$$\n\n$$x^2$$');
  const blocks = root.root.findAll(node => node.props.testID === '自适应块级公式容器' && typeof node.props.onLayout === 'function');
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  await act(async () => blocks.forEach(node => node.props.onLayout({nativeEvent: {layout: {width: 300}}})));
  expect(MathRenderer.Render.mock.calls.map((call: unknown[]) => call[0])).toEqual([
    '\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}(QK^T/\\sqrt{d_k})V', 'x^2',
  ]);
  const svgs = root.root.findAll(node => node.props.testID === '自适应公式 SVG');
  expect(svgs.some(node => node.props.xml.includes('Attention') && node.props.width <= 296 && node.props.height < 28)).toBe(true);
  expect(svgs.some(node => node.props.xml.includes('x^2') && node.props.width === 70 && node.props.height === 28)).toBe(true);
  const beforeCalls = MathRenderer.Render.mock.calls.length;
  await act(async () => blocks.forEach(node => node.props.onLayout({nativeEvent: {layout: {width: 180}}})));
  const narrowed = root.root.findAll(node => node.props.testID === '自适应公式 SVG');
  expect(narrowed.some(node => node.props.xml.includes('Attention') && node.props.width <= 176)).toBe(true);
  expect(MathRenderer.Render.mock.calls).toHaveLength(beforeCalls);
  MathRenderer.Render.mockReset();
  await act(async () => root.unmount());
});


it('never executes raw HTML or opens unsafe/local URLs', async () => {
  // eslint-disable-next-line no-script-url -- adversarial message fixture, never executed.
  for (const link of ['javascript:alert(1)', 'file:///C:/fixture.txt', 'content://fixture', 'https://user:pass@example.com/']) expect(safeMarkdownLink(link)).toBe('');
  expect(safeMarkdownLink('https://example.com/docs')).toBe('https://example.com/docs');
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const root = await render('<script>alert(1)</script>\n\n[safe](https://example.com/docs) [unsafe](javascript:alert(1))');
  const link = root.root.findAllByType(Text).find(node => typeof node.props.onPress === 'function')!;
  await act(async () => link.props.onPress());
  expect(open).toHaveBeenCalledWith('https://example.com/docs');
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); open.mockRestore();
});

it('does not extract media or strip tags from code examples and preserves autolinks', () => {
  const source = '```html\n<img src="https://media.example/a.png">\n![image](https://media.example/b.png)\n```\n`![inline](https://media.example/c.png)`\n\n<https://example.com/docs>';
  const blocks = parseConversationContent(source);
  expect(blocks.some(block => block.kind === 'media')).toBe(false);
  expect(blocks).toEqual([{kind: 'text', value: source}]);
});
