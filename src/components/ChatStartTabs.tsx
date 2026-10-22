import React, {useEffect, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View} from 'react-native';
import {useThemedStyles} from './theme';

export type ChatStartTab = 'new' | 'opened';
const tabs: Array<{value: ChatStartTab; label: string}> = [
  {value: 'new', label: '新的聊天'},
  {value: 'opened', label: '已打开会话'},
];

export function ChatStartTabs({selected, onSelect}: {selected: ChatStartTab; onSelect: (tab: ChatStartTab) => void}) {
  const s = useThemedStyles(styles);
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const position = useRef(new Animated.Value(selected === 'new' ? 0 : 1)).current;
  const swell = useRef(new Animated.Value(0)).current;
  const previous = useRef(selected);
  const tabWidth = Math.max(0, (width - 14) / 2);

  useEffect(() => {
    let active = true;
    let changed = false;
    AccessibilityInfo.isReduceMotionEnabled().then(value => {if (active && !changed) setReduceMotion(value);}).catch(() => undefined);
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {changed = true; setReduceMotion(value);});
    return () => {active = false; listener.remove();};
  }, []);
  useEffect(() => {
    const target = selected === 'new' ? 0 : 1;
    const unchanged = previous.current === selected;
    previous.current = selected;
    swell.setValue(0);
    if (reduceMotion || unchanged) {position.setValue(target); return;}
    const animation = Animated.parallel([
      Animated.spring(position, {toValue: target, stiffness: 240, damping: 24, mass: 0.85, useNativeDriver: true}),
      Animated.sequence([
        Animated.timing(swell, {toValue: 1, duration: 100, useNativeDriver: true}),
        Animated.timing(swell, {toValue: 0, duration: 180, useNativeDriver: true}),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [position, reduceMotion, selected, swell]);

  return <View accessibilityRole="tablist" accessibilityLabel="聊天页面" style={s.tabs} onLayout={event => {
    const next = event.nativeEvent.layout.width;
    if (Number.isFinite(next) && next > 0) setWidth(next);
  }}>
    <Animated.View testID="chat-start-tab-bubble" accessible={false} pointerEvents="none" style={[s.bubble, width <= 0 && s.hiddenBubble, {
      width: tabWidth,
      transform: [
        {translateX: position.interpolate({inputRange: [0, 1], outputRange: [0, tabWidth + 6], extrapolate: 'clamp'})},
        {scaleX: swell.interpolate({inputRange: [0, 1], outputRange: [1, 1.08]})},
        {scaleY: swell.interpolate({inputRange: [0, 1], outputRange: [1, 0.94]})},
      ],
    }]} />
    {tabs.map(tab => <Pressable key={tab.value} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{selected: selected === tab.value}} onPress={() => onSelect(tab.value)} style={s.tab}>
      <Text style={[s.label, selected === tab.value && s.activeLabel]}>{tab.label}</Text>
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({
  tabs: {flexDirection: 'row', marginHorizontal: 18, marginTop: 14, padding: 4, gap: 6, borderRadius: 22, backgroundColor: '#F2F0E9', overflow: 'hidden'},
  tab: {flex: 1, minWidth: 0, minHeight: 48, paddingHorizontal: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', borderRadius: 18},
  hiddenBubble: {opacity: 0},

  bubble: {position: 'absolute', top: 4, bottom: 4, left: 4, borderRadius: 18, backgroundColor: '#F9E5DB'},
  label: {fontSize: 15, lineHeight: 22, fontWeight: '600', color: '#79746C'},
  activeLabel: {color: '#C96849'},
});
