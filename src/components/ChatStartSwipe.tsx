import React, {useRef} from 'react';
import {PanResponder, StyleSheet, View} from 'react-native';
import {chatStartOrder, type ChatStartTab} from './ChatStartTabs';

/** Only claim deliberate horizontal movement; taps and vertical list scrolling stay native. */
export function ChatStartSwipe({selected, onSelect, children}: {
  selected: ChatStartTab;
  onSelect: (tab: ChatStartTab) => void;
  children: React.ReactNode;
}) {
  const current = useRef({selected, onSelect});
  current.current = {selected, onSelect};
  const cancelled = useRef(false);
  const direction = useRef(0);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => {
      const {dx, dy, numberActiveTouches} = gesture;
      return numberActiveTouches === 1 && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.6 &&
        (dx < 0 ? chatStartOrder.indexOf(current.current.selected) < chatStartOrder.length - 1 : chatStartOrder.indexOf(current.current.selected) > 0);
    },
    onPanResponderGrant: (_, gesture) => {cancelled.current = false; direction.current = Math.sign(gesture.dx);},
    onPanResponderMove: (_, gesture) => {if (gesture.numberActiveTouches !== 1) cancelled.current = true;},
    onPanResponderRelease: (_, gesture) => {
      const {dx, dy, vx} = gesture;
      if (cancelled.current || gesture.numberActiveTouches > 1 || Math.abs(dx) <= Math.abs(dy) * 1.6) return;
      const deliberate = Math.abs(dx) >= 56 || (Math.abs(dx) >= 24 && Math.abs(vx) >= 0.45 && dx * vx > 0);
      const {selected: from, onSelect: select} = current.current;
      const next = chatStartOrder[chatStartOrder.indexOf(from) + (dx < 0 ? 1 : -1)];
      if (deliberate && next && (!direction.current || Math.sign(dx) === direction.current)) select(next);
    },
    onPanResponderTerminate: () => {cancelled.current = true;},
  })).current;
  return <View testID="chat-start-swipe" style={styles.page} {...pan.panHandlers}>{children}</View>;
}
const styles = StyleSheet.create({page: {flex: 1, minHeight: 0}});
