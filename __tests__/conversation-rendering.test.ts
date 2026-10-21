import {createConversationScrollController} from '../src/components/conversationScroll';
import {reconcileDesktopMessages} from '../src/components/conversationTimeline';
import type {RemoteMessage} from '../src/remote/api';

function message(uiMessageId: string, messageId = uiMessageId, order = 1): RemoteMessage {
  return {
    uiMessageId, messageId, order, role: 'assistant',
    payload: {content: '', reasoningContent: 'thought fixture', summary: '', summaryPrefix: '', timestamp: '', completedTimestamp: '', aiName: '', voiceName: '', status: '', toolCalls: []},
  };
}

function scrolling() {
  const frames = new Map<number, () => void>();
  let id = 0;
  const scrollToEnd = jest.fn();
  const onPinnedChange = jest.fn();
  const controller = createConversationScrollController({
    scheduler: {request: callback => { frames.set(++id, callback); return id; }, cancel: key => { frames.delete(key); }},
    scrollToEnd, onPinnedChange,
  });
  return {controller, frames, scrollToEnd, onPinnedChange, flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }};
}

describe('conversation auto-follow has one owner', () => {
  it('coalesces content growth in one frame, and never follows equal/shrunken layouts or deletion', () => {
    const f = scrolling();
    f.controller.onLayout(500);
    f.controller.onContentSize(1000);
    f.controller.onContentSize(1030);
    f.controller.onContentSize(1030);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(f.scrollToEnd).toHaveBeenLastCalledWith(false, 530);
    f.controller.onContentSize(700);
    f.controller.onContentSize(700);
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending follow as soon as reading begins and ignores programmatic scroll intent', () => {
    const f = scrolling();
    f.controller.onLayout(500);
    f.controller.onContentSize(1000);
    f.controller.beginDrag();
    f.controller.onScroll(100, 500, 1000);
    f.controller.endDrag();
    f.flush();
    expect(f.scrollToEnd).not.toHaveBeenCalled();
    expect(f.controller.pinned).toBe(false);
    f.controller.onContentSize(1200);
    f.controller.onLayout(300);
    f.controller.onScroll(900, 300, 1200); // A non-user layout/scroll event.
    f.flush();
    expect(f.controller.pinned).toBe(false);
    expect(f.scrollToEnd).not.toHaveBeenCalled();
  });

  it('re-enables follow by manual bottom scrolling or bottom action; keyboard hide does not move the list', () => {
    const f = scrolling();
    f.controller.onLayout(600);
    f.controller.leaveBottom();
    f.controller.beginDrag();
    f.controller.onScroll(600, 600, 1200);
    f.controller.endDrag();
    expect(f.controller.pinned).toBe(true);
    f.controller.onContentSize(1300);
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(1);
    f.controller.onLayout(350);
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(2);
    f.controller.onLayout(600);
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(2);
    f.controller.leaveBottom();
    f.controller.jumpToBottom();
    expect(f.controller.pinned).toBe(true);
    expect(f.scrollToEnd).toHaveBeenLastCalledWith(true, 700);
    f.controller.onContentSize(1500);
    f.controller.dispose();
    f.flush();
    expect(f.scrollToEnd).toHaveBeenCalledTimes(3);
  });
});

describe('Desktop message page is the only timeline truth', () => {
  it('preserves every UI message ID and tool grouping, even when canonical IDs or reasoning match', () => {
    const thought = message('thought-ui', 'same-canonical');
    const tool = {...message('tool-ui', 'same-canonical', 2), payload: {...thought.payload, toolCalls: [{id: 'tool-one', name: 'safe_tool', status: 'executing'}]}};
    const other = {...message('other-ui', 'other', 3), payload: {...thought.payload, toolCalls: [{id: 'tool-two', name: 'safe_tool', status: 'finished'}]}};
    const page = [thought, tool, other];
    const result = reconcileDesktopMessages([], page);
    expect(result).toEqual(page);
    expect(result.map(row => row.uiMessageId)).toEqual(['thought-ui', 'tool-ui', 'other-ui']);
    expect(result.map(row => row.payload.toolCalls.map(call => call.id))).toEqual([[], ['tool-one'], ['tool-two']]);
    expect(result.some(row => row.uiMessageId.startsWith('live-'))).toBe(false);
  });

  it('reuses unchanged rows and the entire array, but applies exact Desktop edits and deletion', () => {
    const previous = [message('first'), message('second', 'second', 2)];
    expect(reconcileDesktopMessages(previous, JSON.parse(JSON.stringify(previous)))).toBe(previous);
    const changed = {...previous[1], payload: {...previous[1].payload, content: 'edited by Desktop'}};
    const next = reconcileDesktopMessages(previous, [JSON.parse(JSON.stringify(previous[0])), changed]);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(changed);
    expect(reconcileDesktopMessages(next, [changed])).toEqual([changed]);
    expect(reconcileDesktopMessages(next, [])).toEqual([]);
  });
});
