import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Linking, ScrollView, StyleSheet, Text} from 'react-native';
import {fitDisplayMath, NativeMarkdown} from '../src/components/NativeMarkdown';
import {parseMarkdown, safeMarkdownLink, type MarkdownNode} from '../src/components/markdownParser';
import {parseConversationContent} from '../src/components/conversationMediaMarkup';

const flatten = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
async function render(value: string) {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(<NativeMarkdown value={value} />); });
  return root;
}

it('parses real Markdown table structure with alignment, escaped pipes and inline formats', () => {
  const nodes = flatten(parseMarkdown('| 名称 | 值 |\n| :--- | ---: |\n| **项目** | `a\\|b` |\n| 测试 | 42 |'));
  expect(nodes.filter(node => node.type === 'table')).toHaveLength(1);
  expect(nodes.filter(node => node.type === 'tr')).toHaveLength(3);
  expect(nodes.filter(node => node.type === 'th').map(node => node.attrs.style)).toEqual(['text-align:left', 'text-align:right']);
  expect(nodes.some(node => node.type === 'code_inline' && node.content === 'a|b')).toBe(true);
  expect(nodes.some(node => node.type === 'strong')).toBe(true);
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
