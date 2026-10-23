import React, {useCallback, useEffect, useImperativeHandle, useMemo, useRef} from 'react';
import {ScrollView, View, type StyleProp, type ViewStyle} from 'react-native';
import type {RemoteMessage} from '../remote/api';
import {createConversationScrollController} from './conversationScroll';

/** Expand/collapse is a reading action, not incoming content to follow. */
export const MessageLayoutInteractionContext = React.createContext<() => void>(() => undefined);

export type ConversationMessageListHandle = {
  top: () => void;
  bottom: () => void;
  adjacent: (direction: -1 | 1) => void;
};

type RowLayout = {y: number; height: number};
type Anchor = {id: string; displacement: number};

/**
 * Mount every ALREADY LOADED row. A dynamic tool/reasoning height must not
 * invalidate a virtual window or leave estimated spacers hiding the tail.
 * Remote history remains paginated; this component never fetches data.
 */
export const ConversationMessageList = React.forwardRef<ConversationMessageListHandle, {
  messages: RemoteMessage[];
  renderMessage: (message: RemoteMessage) => React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  onPinnedChange: (pinned: boolean) => void;
  onOlder?: () => void;
  hasOlder?: boolean;
}>(function ConversationMessageListView({messages, renderMessage, header, footer, style, contentContainerStyle, onPinnedChange, onOlder, hasOlder}, ref) {
  const host = useRef<ScrollView>(null);
  const rows = useRef(messages);
  rows.current = messages;
  const layouts = useRef(new Map<string, RowLayout>());
  const geometry = useRef({offset: 0, viewport: 0, height: 0, interacting: false});
  const anchor = useRef<Anchor | undefined>(undefined);
  const anchorFrame = useRef<number | undefined>(undefined);
  const navigationTarget = useRef<number | undefined>(undefined);
  const pinnedCallback = useRef(onPinnedChange);
  pinnedCallback.current = onPinnedChange;
  const scroll = useMemo(() => createConversationScrollController({
    scheduler: {request: requestAnimationFrame, cancel: cancelAnimationFrame},
    scrollToEnd: (animated, offset) => {
      geometry.current.offset = offset;
      navigationTarget.current = animated ? offset : undefined;
      host.current?.scrollTo({y: offset, animated});
    },
    onPinnedChange: pinned => pinnedCallback.current(pinned),
  }), []);

  const cancelAnchorFrame = useCallback(() => {
    if (anchorFrame.current !== undefined) cancelAnimationFrame(anchorFrame.current);
    anchorFrame.current = undefined;
  }, []);

  const captureAnchor = useCallback(() => {
    const offset = geometry.current.offset;
    const visible = rows.current.find(message => {
      const layout = layouts.current.get(message.uiMessageId);
      return layout && layout.y + layout.height > offset + 1;
    });
    const layout = visible && layouts.current.get(visible.uiMessageId);
    anchor.current = visible && layout ? {id: visible.uiMessageId, displacement: layout.y - offset} : undefined;
  }, []);

  const restoreAnchor = useCallback(() => {
    if (scroll.pinned || geometry.current.interacting || !anchor.current || anchorFrame.current !== undefined) return;
    anchorFrame.current = requestAnimationFrame(() => {
      anchorFrame.current = undefined;
      const saved = anchor.current;
      const layout = saved && layouts.current.get(saved.id);
      if (!saved || !layout || scroll.pinned || geometry.current.interacting) return;
      const maxOffset = Math.max(0, geometry.current.height - geometry.current.viewport);
      const offset = Math.max(0, Math.min(maxOffset, layout.y - saved.displacement));
      if (Math.abs(offset - geometry.current.offset) > 1) {
        geometry.current.offset = offset;
        host.current?.scrollTo({y: offset, animated: false});
      }
    });
  }, [scroll]);

  const beforeLayoutChange = useCallback(() => {
    cancelAnchorFrame();
    captureAnchor();
    navigationTarget.current = undefined;
    geometry.current.interacting = false;
    scroll.leaveBottom();
  }, [cancelAnchorFrame, captureAnchor, scroll]);

  const moveTo = useCallback((offset: number) => {
    cancelAnchorFrame();
    scroll.leaveBottom();
    anchor.current = undefined;
    geometry.current.interacting = false;
    geometry.current.offset = Math.max(0, Math.min(offset, Math.max(0, geometry.current.height - geometry.current.viewport)));
    navigationTarget.current = geometry.current.offset;
    host.current?.scrollTo({y: geometry.current.offset, animated: true});
  }, [cancelAnchorFrame, scroll]);

  useImperativeHandle(ref, () => ({
    top: () => moveTo(0),
    bottom: () => {
      cancelAnchorFrame();
      anchor.current = undefined;
      geometry.current.interacting = false;
      geometry.current.offset = Math.max(0, geometry.current.height - geometry.current.viewport);
      scroll.jumpToBottom(true);
    },
    adjacent: direction => {
      const currentRows = rows.current;
      if (!currentRows.length) return;
      const offset = geometry.current.offset;
      const visible = currentRows.findIndex(message => {
        const layout = layouts.current.get(message.uiMessageId);
        return layout && layout.y + layout.height > offset + 1;
      });
      const index = Math.max(0, Math.min(currentRows.length - 1, Math.max(0, visible) + direction));
      const layout = layouts.current.get(currentRows[index].uiMessageId);
      if (layout) moveTo(layout.y);
    },
  }), [cancelAnchorFrame, moveTo, scroll]);

  useEffect(() => {
    const ids = new Set(messages.map(message => message.uiMessageId));
    for (const id of layouts.current.keys()) if (!ids.has(id)) layouts.current.delete(id);
    if (anchor.current && !ids.has(anchor.current.id)) captureAnchor();
  }, [captureAnchor, messages]);
  useEffect(() => () => { scroll.dispose(); cancelAnchorFrame(); }, [cancelAnchorFrame, scroll]);

  const beginDrag = () => {
    cancelAnchorFrame();
    navigationTarget.current = undefined;
    geometry.current.interacting = true;
    scroll.beginDrag();
  };
  const endDrag = () => {
    geometry.current.interacting = false;
    scroll.endDrag();
    if (!scroll.pinned) captureAnchor();
  };

  return <MessageLayoutInteractionContext.Provider value={beforeLayoutChange}>
    <ScrollView
      ref={host}
      accessibilityLabel="聊天消息列表"
      style={style}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      nestedScrollEnabled
      removeClippedSubviews={false}
      scrollEventThrottle={16}
      onScrollBeginDrag={beginDrag}
      onScrollEndDrag={endDrag}
      onMomentumScrollBegin={() => { if (navigationTarget.current === undefined) beginDrag(); }}
      onMomentumScrollEnd={() => { navigationTarget.current = undefined; endDrag(); }}
      onScroll={event => {
        const {contentOffset, layoutMeasurement, contentSize} = event.nativeEvent;
        geometry.current.offset = contentOffset.y;
        geometry.current.viewport = layoutMeasurement.height;
        scroll.onScroll(contentOffset.y, layoutMeasurement.height, contentSize.height);

        if (geometry.current.interacting && contentOffset.y < 80 && hasOlder) onOlder?.();
        if (navigationTarget.current !== undefined) {
          if (Math.abs(contentOffset.y - navigationTarget.current) > 1) return;
          navigationTarget.current = undefined;
        }
        if (!scroll.pinned && (geometry.current.interacting || !anchor.current)) captureAnchor();
      }}
      onContentSizeChange={(_width, height) => {
        geometry.current.height = height;
        scroll.onContentSize(height);
        restoreAnchor();
      }}
      onLayout={event => {
        geometry.current.viewport = event.nativeEvent.layout.height;
        scroll.onLayout(event.nativeEvent.layout.height);
      }}
    >
      {header}
      {messages.map(message => <View
        key={message.uiMessageId}
        testID={`message-row-${message.uiMessageId}`}
        collapsable={false}
        onLayout={event => {
          const {y, height} = event.nativeEvent.layout;
          layouts.current.set(message.uiMessageId, {y, height});
          restoreAnchor();
        }}
      >{renderMessage(message)}</View>)}
      {footer}
    </ScrollView>
  </MessageLayoutInteractionContext.Provider>;
});
