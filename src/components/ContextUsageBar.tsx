import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {ContextUsage} from '../remote/commands';
import {useTheme, useThemedStyles} from './theme';

export function contextUsageLayout(usage: ContextUsage, capacity: number, ratio: number) {
  const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const values = [count(usage.systemTokens), count(usage.conversationTokens), count(usage.toolTokens)];
  const total = values.reduce((a, b) => a + b, 0);
  const limit = Math.max(1, count(capacity));
  let remainingWidth = 100;
  const widths = values.map(value => {const width = Math.min(remainingWidth, value / limit * 100); remainingWidth -= width; return width;});
  const threshold = Math.min(0.99, Math.max(0.1, Number.isFinite(ratio) ? ratio : 0.9));
  return {values, total, capacity: limit, widths, remaining: Math.max(0, limit - total), over: Math.max(0, total - limit), threshold, thresholdTokens: Math.floor(limit * threshold)};
}
export function ContextUsageBar({usage, capacity, ratio, preview = false, autoCompact = true}: {usage?: ContextUsage | null; capacity: number; ratio: number; preview?: boolean; autoCompact?: boolean}) {
  const s = useThemedStyles(styles);
  const theme = useTheme();
  const valid = usage && ['ready', 'calculating', 'stale', 'unavailable'].includes(usage.status) && [usage.systemTokens, usage.conversationTokens, usage.toolTokens, usage.updatedAt].every(value => Number.isFinite(value) && value >= 0);
  if (!valid || !usage || !usage.updatedAt) return <View style={s.card}><Text style={s.title}>当前上下文组成</Text><Text style={s.hint}>统计暂不可用</Text></View>;
  const layout = contextUsageLayout(usage, capacity, ratio);
  const colors = theme.dark ? ['#A9C5FF', '#A3D8B2', '#F0B89C'] : ['#4265A5', '#39734C', '#A14A32'];
  const names = ['系统提示词', '对话', '工具'];
  return <View style={s.card} accessibilityLabel="当前上下文组成">
    <Text style={s.title}>当前上下文组成</Text>
    <Text style={s.hint}>{layout.total.toLocaleString()} / {layout.capacity.toLocaleString()} tokens{preview ? ' · 待保存预览' : ''}</Text>
    <View style={s.track} accessibilityLabel="上下文占用条">
      {layout.widths.map((width, index) => <View key={names[index]} testID={`context-segment-${index}`} style={[s.segment, {width: `${width}%`, backgroundColor: colors[index]}]} />)}
      <View testID="context-threshold" style={[s.marker, {left: `${layout.threshold * 100}%`}]} />
    </View>
    <Text style={s.hint}>压缩阈值 {Math.round(layout.threshold * 100)}% · {layout.thresholdTokens.toLocaleString()} tokens{autoCompact ? '' : '（自动压缩已关闭）'}</Text>
    <View style={s.legend}>{names.map((name, index) => <View key={name} style={s.legendItem}><View style={[s.dot, {backgroundColor: colors[index]}]} /><Text style={s.text}>{name} {layout.values[index].toLocaleString()}</Text></View>)}</View>
    <Text style={layout.over ? s.warning : s.hint}>{layout.over ? `超出容量 ${layout.over.toLocaleString()} tokens` : `剩余 ${layout.remaining.toLocaleString()} tokens`}</Text>
  </View>;
}
const styles = StyleSheet.create({

  segment: {height: '100%'},
  card: {padding: 12, borderRadius: 16, backgroundColor: '#F2F0E9', gap: 8}, title: {fontSize: 14, fontWeight: '600', color: '#292724'}, hint: {fontSize: 12, lineHeight: 18, color: '#79746C'}, text: {fontSize: 12, color: '#292724'},
  track: {height: 18, flexDirection: 'row', position: 'relative', borderRadius: 5, backgroundColor: '#E7E1D8', overflow: 'hidden'}, marker: {position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#292724'},
  legend: {flexDirection: 'row', flexWrap: 'wrap', gap: 10}, legendItem: {flexDirection: 'row', alignItems: 'center', gap: 5}, dot: {width: 8, height: 8, borderRadius: 3}, warning: {fontSize: 12, color: '#B84E52'},
});
