import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, Linking, StyleSheet, Text, View} from 'react-native';
import Video from 'react-native-video';
import {MathText} from 'react-native-latex-text';

import type {RemoteRequest} from '../remote/api';
import {getConversationMediaCache} from '../services/conversationMediaCache';
import {
  hasRenderableConversationContent,
  parseConversationContent,
  type ConversationMedia,
} from './conversationMediaMarkup';

export {hasRenderableConversationContent};

const C = {text: '#292724', muted: '#79746C', mutedSurface: '#F2F0E9', primary: '#C96849', danger: '#B84E52'};

type Inline = {kind: 'text' | 'bold' | 'code' | 'link'; value: string; href?: string};
type MediaState = {uri: string; mimeType: string};

function inlineMarkdown(text: string): Inline[] {
  const output: Inline[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > cursor) output.push({kind: 'text', value: text.slice(cursor, index)});
    const value = match[0];
    if (value.startsWith('**')) output.push({kind: 'bold', value: value.slice(2, -2)});
    else if (value.startsWith('`')) output.push({kind: 'code', value: value.slice(1, -1)});
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(value);
      if (link) output.push({kind: 'link', value: link[1], href: link[2]});
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) output.push({kind: 'text', value: text.slice(cursor)});
  return output;
}

function MarkdownText({value, color = C.text}: {value: string; color?: string}) {
  const content = useMemo(() => {
    const rows: Array<{kind: 'text' | 'code'; value: string}> = [];
    const code: string[] = [];
    let inCode = false;
    for (const line of value.split('\n')) {
      if (/^\s*```/.test(line)) {
        if (inCode) rows.push({kind: 'code', value: code.join('\n')});
        code.length = 0;
        inCode = !inCode;
        continue;
      }
      if (inCode) code.push(line);
      else rows.push({kind: 'text', value: line});
    }
    if (inCode) rows.push({kind: 'code', value: code.join('\n')});
    return rows;
  }, [value]);
  return <View style={styles.textFlow}>{content.map((row, index) => {
    if (row.kind === 'code') return <Text key={`code-${index}`} selectable style={styles.codeBlock}>{row.value || ' '}</Text>;
    const line = row.value;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const list = /^\s*[-*+]\s+(.+)$/.exec(line);
    const normalized = heading ? heading[2] : list ? `• ${list[1]}` : line;
    const hasMath = /\$\$[\s\S]*\$\$|\\\[[\s\S]*\\\]|\$[^$\n]+\$|\\\([^\n]+\\\)/.test(normalized);
    if (hasMath) return <MathText key={`math-${index}`} content={normalized} textColor={color} fontSize={heading ? 17 : 15} baseMathSize={10} lineHeight={1.45} viewStyle={styles.mathLine} />;
    return <Text key={`text-${index}`} selectable style={[styles.text, heading && styles.heading, {color}]}>{inlineMarkdown(normalized).map((part, partIndex) => {
      if (part.kind === 'bold') return <Text key={partIndex} style={styles.bold}>{part.value}</Text>;
      if (part.kind === 'code') return <Text key={partIndex} style={styles.inlineCode}>{part.value}</Text>;
      if (part.kind === 'link') return <Text key={partIndex} style={styles.link} onPress={() => part.href && Linking.openURL(part.href).catch(() => undefined)}>{part.value}</Text>;
      return <React.Fragment key={partIndex}>{part.value}</React.Fragment>;
    })}</Text>;
  })}</View>;
}

function MediaPreview({media, desktopId, conversationId, request}: {media: ConversationMedia; desktopId: string; conversationId: string; request: RemoteRequest}) {
  const [state, setState] = useState<MediaState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    setState(null);
    if (!media.opaque) {
      setState({uri: media.uri, mimeType: ''});
      return () => { active = false; };
    }
    getConversationMediaCache({desktopId, conversationId, mediaId: media.uri.match(/^anywhere-media:\/\/([A-Za-z0-9_-]{16,160})/)?.[1] || '', request})
      .then(value => { if (active) setState(value); })
      .catch(() => { if (active) setError('媒体暂不可用'); });
    return () => { active = false; };
  }, [conversationId, desktopId, media.opaque, media.uri, request]);
  if (error) return <View style={styles.mediaPlaceholder}><Text style={styles.mediaError}>{error}</Text></View>;
  if (!state) return <View style={styles.mediaPlaceholder}><ActivityIndicator color={C.primary} /><Text style={styles.mediaHint}>正在获取加密媒体…</Text></View>;
  if (media.kind === 'image') return <Image accessibilityLabel="聊天图片" source={{uri: state.uri}} resizeMode="contain" style={styles.image} onError={() => setError('图片加载失败')} />;
  if (media.kind === 'video') return <Video source={{uri: state.uri}} controls resizeMode="contain" style={styles.video} onError={() => setError('视频播放失败')} />;
  return <View style={styles.audio}><Text style={styles.audioTitle}>音频</Text><Video source={{uri: state.uri}} controls style={styles.audioPlayer} onError={() => setError('音频播放失败')} /></View>;
}

/** Render constrained Markdown/HTML media. Direct media is HTTPS-only; local Desktop media must use opaque IDs. */
export function ConversationMarkdown({value, desktopId, conversationId, request, color}: {value: string; desktopId: string; conversationId: string; request: RemoteRequest; color?: string}) {
  const blocks = useMemo(() => parseConversationContent(value), [value]);
  return <View style={styles.root}>{blocks.map(block => block.kind === 'text'
    ? <MarkdownText key={`text-${block.value.slice(0, 32)}-${blocks.indexOf(block)}`} value={block.value} color={color} />
    : <MediaPreview key={block.media.key} media={block.media} desktopId={desktopId} conversationId={conversationId} request={request} />,
  )}</View>;
}

const styles = StyleSheet.create({
  root: {gap: 9},
  textFlow: {gap: 4},
  text: {fontSize: 15, lineHeight: 23},
  heading: {fontSize: 17, fontWeight: '800', marginTop: 4},
  bold: {fontWeight: '800'},
  inlineCode: {fontFamily: 'monospace', fontSize: 13, color: '#80533E', backgroundColor: '#EAE5DC'},
  codeBlock: {fontFamily: 'monospace', color: C.text, backgroundColor: '#EAE5DC', paddingHorizontal: 9, paddingVertical: 7, borderRadius: 8, fontSize: 12, lineHeight: 18},
  link: {color: C.primary, fontWeight: '700', textDecorationLine: 'underline'},
  mathLine: {marginVertical: 1},
  mediaPlaceholder: {minHeight: 68, alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, backgroundColor: C.mutedSurface},
  mediaHint: {fontSize: 12, color: C.muted},
  mediaError: {fontSize: 12, color: C.danger},
  image: {width: '100%', height: 220, borderRadius: 14, backgroundColor: C.mutedSurface},
  video: {width: '100%', aspectRatio: 16 / 9, borderRadius: 14, backgroundColor: '#171513'},
  audio: {gap: 7, padding: 11, borderRadius: 14, backgroundColor: C.mutedSurface},
  audioTitle: {color: C.text, fontSize: 13, fontWeight: '800'},
  audioPlayer: {height: 48, width: '100%'},
});
