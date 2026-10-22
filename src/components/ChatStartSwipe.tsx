import React, {useRef} from 'react';
import {PanResponder, StyleSheet, View} from 'react-native';
import type {ChatStartTab} from './ChatStartTabs';

/** Only claim deliberate horizontal movement; taps and vertical list scrolling stay native. */
export function ChatStartSwipe({selected, onSelect, children}: {
  selected: ChatStartTab;
  onSelect: (tab: ChatStartTab) => void;
  children: React.ReactNode;
}) {
  const current = useRef({selected, onSelect});
  current.current = {selected, onSelect};
  const cancelled = useRef(false);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => {
      const {dx, dy, numberActiveTouches} = gesture;
      return numberActiveTouches === 1 && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.6 &&
        (current.current.selected === 'new' ? dx < 0 : dx > 0);
    },
    onPanResponderGrant: () => {cancelled.current = false;},
    onPanResponderMove: (_, gesture) => {if (gesture.numberActiveTouches !== 1) cancelled.current = true;},
    onPanResponderRelease: (_, gesture) => {
      const {dx, dy, vx} = gesture;
      if (cancelled.current || gesture.numberActiveTouches > 1 || Math.abs(dx) <= Math.abs(dy) * 1.6) return;
      const deliberate = Math.abs(dx) >= 56 || (Math.abs(dx) >= 24 && Math.abs(vx) >= 0.45 && dx * vx > 0);
      const {selected: from, onSelect: select} = current.current;
      if (deliberate && (from === 'new' ? dx < 0 : dx > 0)) select(from === 'new' ? 'opened' : 'new');
    },
    onPanResponderTerminate: () => {cancelled.current = true;},
  })).current;
  return <View testID="chat-start-swipe" style={styles.page} {...pan.panHandlers}>{children}</View>;
}
const styles = StyleSheet.create({page: {flex: 1, minHeight: 0}});
