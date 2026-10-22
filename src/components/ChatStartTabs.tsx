import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useThemedStyles} from './theme';

export type ChatStartTab = 'new' | 'opened';
const tabs: Array<{value: ChatStartTab; label: string}> = [
  {value: 'new', label: '新的聊天'},
  {value: 'opened', label: '打开的会话'},
];

export function ChatStartTabs({selected, onSelect}: {selected: ChatStartTab; onSelect: (tab: ChatStartTab) => void}) {
  const s = useThemedStyles(styles);
  return <View accessibilityRole="tablist" accessibilityLabel="聊天页面" style={s.tabs}>
    {tabs.map(tab => <Pressable key={tab.value} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{selected: selected === tab.value}} onPress={() => onSelect(tab.value)} style={[s.tab, selected === tab.value && s.active]}>
      <Text style={[s.label, selected === tab.value && s.activeLabel]}>{tab.label}</Text>
      {selected === tab.value ? <View testID="chat-start-tab-indicator" style={s.indicator} /> : null}
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({
  tabs: {flexDirection: 'row', marginHorizontal: 18, marginTop: 14, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E7E1D8'},
  tab: {flex: 1, minWidth: 0, minHeight: 48, paddingHorizontal: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: 15, borderTopRightRadius: 15},
  active: {backgroundColor: '#F9E5DB'},
  label: {fontSize: 15, lineHeight: 22, fontWeight: '600', color: '#79746C'},
  activeLabel: {color: '#C96849'},
  indicator: {position: 'absolute', bottom: 0, height: 2, left: 16, right: 16, borderRadius: 1, backgroundColor: '#C96849'},
});
