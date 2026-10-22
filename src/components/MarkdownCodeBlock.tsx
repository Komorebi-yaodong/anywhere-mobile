import React, {useMemo} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useThemedStyles} from './theme';

const CODE_LINE_HEIGHT = 18;
export const CODE_VIEWPORT_MAX_HEIGHT = 320;
const CHUNK_LINES = 24;

/** Keep code literal and intact, but avoid one enormous native Text layout. */
export function codeTextChunks(content: string): string[] {
  const lines = content.split('\n');
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    chunks.push(lines.slice(start, start + CHUNK_LINES).join('\n'));
  }
  return chunks;
}

export function MarkdownCodeBlock({content, language = ''}: {content: string; language?: string}) {
  const s = useThemedStyles(styles);
  const {fontScale} = useWindowDimensions();
  const value = content.replace(/\n$/, '');
  const chunks = useMemo(() => codeTextChunks(value), [value]);
  const lineCount = value.split('\n').length;
  const viewportHeight = Math.min(CODE_VIEWPORT_MAX_HEIGHT, Math.ceil(lineCount * CODE_LINE_HEIGHT * Math.max(1, fontScale) + 20));
  return <View accessibilityLabel="Markdown 代码块" style={s.frame}>
    <View style={s.header}>
      <Text style={s.language}>{language.trim().split(/\s/)[0] || '代码'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="复制完整代码" hitSlop={4} style={s.copy} onPress={() => Clipboard.setString(content)}><Text style={s.copyText}>复制</Text></Pressable>
    </View>
    <ScrollView accessibilityLabel="代码横向滚动" horizontal nestedScrollEnabled removeClippedSubviews={false} style={[s.horizontal, {height: viewportHeight}]} contentContainerStyle={s.horizontalContent} keyboardShouldPersistTaps="handled">
      <ScrollView accessibilityLabel="代码纵向滚动" nestedScrollEnabled removeClippedSubviews={false} style={[s.vertical, {height: viewportHeight}]} contentContainerStyle={s.codeContent} keyboardShouldPersistTaps="handled">
        {chunks.map((chunk, index) => <Text key={index} selectable style={s.code}>{chunk || ' '}</Text>)}
      </ScrollView>
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  frame: {width: '100%', maxWidth: '100%', minWidth: 0, flexGrow: 0, flexShrink: 0, borderRadius: 10, overflow: 'hidden', backgroundColor: '#EAE5DC'},
  header: {minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DDD6CB'},
  language: {color: '#79746C', fontSize: 11}, copy: {minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center'}, copyText: {fontSize: 12, fontWeight: '600', color: '#C96849'},
  horizontal: {width: '100%', maxWidth: '100%', minWidth: 0, flexGrow: 0, flexShrink: 0},
  horizontalContent: {alignItems: 'flex-start'},
  vertical: {flexGrow: 0, flexShrink: 0},
  codeContent: {alignItems: 'flex-start', padding: 10},
  code: {fontFamily: 'monospace', color: '#292724', fontSize: 12, lineHeight: CODE_LINE_HEIGHT, flexGrow: 0, flexShrink: 0},
});
