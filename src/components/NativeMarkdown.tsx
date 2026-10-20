import React, {useMemo, useState} from 'react';
import {Linking, ScrollView, StyleSheet, Text, View, type TextStyle} from 'react-native';
import {MathText} from 'react-native-latex-text';
import {parseMarkdown, safeMarkdownLink, type MarkdownNode} from './markdownParser';

const C = {text: '#292724', muted: '#79746C', line: '#DDD6CB', code: '#EAE5DC', primary: '#C96849', header: '#EDE8DE'};

function InlineNodes({nodes}: {nodes: MarkdownNode[]}) {
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    const children = <InlineNodes nodes={node.children} />;
    switch (node.type) {
      case 'strong': return <Text key={key} style={styles.bold}>{children}</Text>;
      case 'em': return <Text key={key} style={styles.italic}>{children}</Text>;
      case 's': return <Text key={key} style={styles.strike}>{children}</Text>;
      case 'code_inline': return <Text key={key} style={styles.inlineCode}>{node.content}</Text>;
      case 'link': {
        const href = safeMarkdownLink(node.attrs.href || '');
        return <Text key={key} style={href ? styles.link : undefined} onPress={href ? () => Linking.openURL(href).catch(() => undefined) : undefined}>{children}</Text>;
      }
      case 'softbreak': case 'hardbreak': return <Text key={key}>{'\n'}</Text>;
      default: return <React.Fragment key={key}>{node.children.length ? children : node.content}</React.Fragment>;
    }
  })}</>;
}

function hasMath(nodes: MarkdownNode[]): boolean {
  return nodes.some(node => node.type === 'math_inline' || hasMath(node.children));
}
function mathSource(nodes: MarkdownNode[]): string {
  return nodes.map(node => {
    const value = node.children.length ? mathSource(node.children) : node.content;
    if (node.type === 'strong') return `**${value}**`;
    if (node.type === 'em') return `*${value}*`;
    if (node.type === 'code_inline') return `\`${value}\``;
    if (node.type === 'softbreak' || node.type === 'hardbreak') return '\n';
    return value;
  }).join('');
}
function Paragraph({nodes, color, style}: {nodes: MarkdownNode[]; color: string; style?: TextStyle}) {
  // Preserve the existing MathText engine for mixed prose/formulas. Fences and
  // inline code have separate tokens and can never activate this path alone.
  if (hasMath(nodes)) return <MathText content={mathSource(nodes)} textColor={color} fontSize={style?.fontSize || 15} baseMathSize={10} lineHeight={1.5} viewStyle={styles.math} />;
  return <Text selectable style={[styles.text, {color}, style]}><InlineNodes nodes={nodes} /></Text>;
}
function tableRows(node: MarkdownNode): MarkdownNode[] {
  return node.children.flatMap(child => child.type === 'tr' ? [child] : tableRows(child));
}
function Table({node, color}: {node: MarkdownNode; color: string}) {
  const [available, setAvailable] = useState(280);
  const rows = tableRows(node);
  const columns = Math.max(1, ...rows.map(row => row.children.length));
  const width = Math.max(112, Math.min(220, Math.floor(available / Math.min(columns, 3))));
  return <View accessibilityLabel="Markdown 表格" style={styles.tableFrame} onLayout={event => setAvailable(Math.max(1, event.nativeEvent.layout.width))}>
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator keyboardShouldPersistTaps="handled" style={styles.tableScroll}>
      <View accessibilityLabel="表格内容" style={styles.table}>
        {rows.map((row, index) => <View key={index} accessibilityLabel={`表格第 ${index + 1} 行`} style={styles.tableRow}>
          {Array.from({length: columns}, (_, column) => {
            const cell = row.children[column];
            const header = cell?.type === 'th';
            const align = /text-align:\s*(left|center|right)/.exec(cell?.attrs.style || '')?.[1] as TextStyle['textAlign'];
            return <View key={column} accessibilityLabel={header ? '表头' : '单元格'} style={[styles.cell, header && styles.headerCell, {width}]}>
              <Paragraph nodes={cell?.children.flatMap(child => child.type === 'inline' ? child.children : [child]) || []} color={color} style={StyleSheet.flatten([header ? styles.headerText : styles.cellText, {textAlign: align || 'left'}])} />
            </View>;
          })}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}

function Blocks({nodes, color}: {nodes: MarkdownNode[]; color: string}) {
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case 'paragraph': case 'heading':
        return <Paragraph key={key} nodes={node.children.flatMap(child => child.type === 'inline' ? child.children : [child])} color={color} style={node.type === 'heading' ? node.tag === 'h1' ? styles.h1 : node.tag === 'h2' ? styles.h2 : styles.heading : undefined} />;
      case 'inline': return <Paragraph key={key} nodes={node.children} color={color} />;
      case 'fence': case 'code_block': return <ScrollView key={key} horizontal style={styles.codeFrame} keyboardShouldPersistTaps="handled"><Text selectable style={styles.code}>{node.content.replace(/\n$/, '') || ' '}</Text></ScrollView>;
      case 'blockquote': return <View key={key} style={styles.quote}><Blocks nodes={node.children} color={color} /></View>;
      case 'bullet_list': case 'ordered_list': return <View key={key} style={styles.list}>{node.children.map((item, itemIndex) => <View key={itemIndex} style={styles.listRow}><Text style={[styles.marker, {color}]}>{node.type === 'ordered_list' ? `${Number(node.attrs.start || 1) + itemIndex}.` : '•'}</Text><View style={styles.listBody}><Blocks nodes={item.children} color={color} /></View></View>)}</View>;
      case 'table': return <Table key={key} node={node} color={color} />;
      case 'hr': return <View key={key} accessibilityLabel="分隔线" style={styles.rule} />;
      case 'math_block': return <MathText key={key} content={node.content} textColor={color} fontSize={15} baseMathSize={10} lineHeight={1.5} viewStyle={styles.math} />;
      default: return node.children.length ? <View key={key}><Blocks nodes={node.children} color={color} /></View> : node.content ? <Text key={key} selectable style={[styles.text, {color}]}>{node.content}</Text> : null;
    }
  })}</>;
}
export function NativeMarkdown({value, color = C.text}: {value: string; color?: string}) {
  const nodes = useMemo(() => parseMarkdown(value), [value]);
  return <View style={styles.root}><Blocks nodes={nodes} color={color} /></View>;
}
const styles = StyleSheet.create({
  root: {gap: 9, minWidth: 0, maxWidth: '100%', flexShrink: 1},
  text: {fontSize: 15, lineHeight: 23, flexShrink: 1},
  bold: {fontWeight: '800'}, italic: {fontStyle: 'italic'}, strike: {textDecorationLine: 'line-through'},
  inlineCode: {fontFamily: 'monospace', fontSize: 13, color: '#80533E', backgroundColor: C.code},
  link: {color: C.primary, textDecorationLine: 'underline'}, math: {marginVertical: 2, maxWidth: '100%'},
  codeFrame: {backgroundColor: C.code, borderRadius: 8, maxWidth: '100%'},
  code: {fontFamily: 'monospace', color: C.text, padding: 10, fontSize: 12, lineHeight: 18},
  quote: {borderLeftWidth: 3, borderLeftColor: C.line, paddingLeft: 10, gap: 7},
  list: {gap: 5}, listRow: {flexDirection: 'row', gap: 7}, marker: {minWidth: 20, fontSize: 15, lineHeight: 23}, listBody: {flex: 1, minWidth: 0, gap: 5},
  rule: {height: 1, backgroundColor: C.line, marginVertical: 4},
  tableFrame: {maxWidth: '100%', minWidth: 0, borderWidth: 1, borderColor: C.line, borderRadius: 8, overflow: 'hidden'},
  tableScroll: {maxWidth: '100%'}, table: {alignSelf: 'flex-start'}, tableRow: {flexDirection: 'row', alignItems: 'stretch'},
  cell: {padding: 9, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line, justifyContent: 'center'},
  headerCell: {backgroundColor: C.header},
  headerText: {fontWeight: '700'}, cellText: {fontWeight: '400'},
  h1: {fontSize: 23, fontWeight: '800', lineHeight: 32},
  h2: {fontSize: 20, fontWeight: '800', lineHeight: 28},
  heading: {fontSize: 17, fontWeight: '800', lineHeight: 28},

});
