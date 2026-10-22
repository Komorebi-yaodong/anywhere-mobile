import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {StyleSheet} from 'react-native';
import {ContextUsageBar, contextUsageLayout} from '../src/components/ContextUsageBar';
const usage = {status: 'ready' as const, estimated: true, systemTokens: 100, conversationTokens: 300, toolTokens: 100, updatedAt: 1234};
it('matches Desktop categories, capacity and threshold arithmetic', () => {
  expect(contextUsageLayout(usage, 1000, 0.9)).toMatchObject({widths: [10, 30, 10], total: 500, remaining: 500, over: 0, thresholdTokens: 900});
  const over = contextUsageLayout(usage, 250, 0.9);
  expect(over.widths.reduce((a, b) => a + b, 0)).toBe(100);
  expect(over.over).toBe(250);
});
it('shows numeric categories and the saved or draft threshold at the top of context settings', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ContextUsageBar usage={usage} capacity={1000} ratio={0.9} />);});
  expect(JSON.stringify(root.toJSON())).toContain('系统提示词');
  expect(JSON.stringify(root.toJSON())).toContain('工具');
  const marker = root.root.findAll(node => node.props.testID === 'context-threshold' && node.props.style)[0];
  expect(StyleSheet.flatten(marker.props.style).left).toBe('90%');
  await act(async () => root.update(<ContextUsageBar usage={{...usage, status: 'stale'}} capacity={250} ratio={0.8} preview />));
  const output = JSON.stringify(root.toJSON());
  expect(output).toContain('超出容量'); expect(output).toContain('待保存预览'); expect(output).not.toContain('过期');
  await act(async () => root.unmount());
});
it.each(['ready', 'calculating', 'stale', 'unavailable'] as const)('never adds estimate labels, timestamps or freshness notices for %s', async status => {
  let root!: TestRenderer.ReactTestRenderer;
  for (const estimated of [true, false]) {
    await act(async () => {
      const card = <ContextUsageBar usage={{...usage, status, estimated}} capacity={1000} ratio={0.9} />;
      if (root) root.update(card); else root = TestRenderer.create(card);
    });
    const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value ? text(value.children) : '';
    const output = text(root.toJSON());
    expect(output).toContain('当前上下文组成');
    expect(output).toContain('500 / 1,000 tokens');
    expect(output).toContain('系统提示词 100');
    expect(output).toContain('对话 300');
    expect(output).toContain('工具 100');
    expect(output).toContain('剩余 500 tokens');
    expect(output).not.toMatch(/估算|统计|更新于|过期|更新中|\d{1,2}:\d{2}/);
  }
  await act(async () => root.unmount());
});


it('uses a clear unavailable state for an old Desktop, not a fake empty context', async () => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<ContextUsageBar usage={null} capacity={1000} ratio={0.9} />);});
  expect(JSON.stringify(root.toJSON())).toContain('统计暂不可用');
  expect(root.root.findAll(node => node.props.testID === 'context-threshold')).toHaveLength(0);
  await act(async () => root.unmount());
});
