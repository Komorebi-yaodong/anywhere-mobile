import {createConversationScrollController} from '../src/components/conversationScroll';
import {projectConversationTimeline, type LiveTurn} from '../src/components/conversationTimeline';
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

describe('request-stable Mobile preview', () => {
  it('keeps one preview key across reasoning, tool segments and UI-only persisted projections', () => {
    const turn: NonNullable<LiveTurn> = {requestId: 'request-fixture', segmentId: 'segment-one', text: '', reasoning: 'thought fixture', baselineUiMessageIds: ['old-ui'], baselineLastOrder: 5, terminal: false};
    const old = message('old-ui', 'old-storage', 5);
    const first = projectConversationTimeline([old], turn);
    expect(first.messages.map(item => item.renderKey)).toEqual(['old-ui', 'live-turn-request-fixture']);
    const tool = {id: 'tool-one', name: 'safe_tool', status: 'executing', arguments: '[参数已隐藏]'};
    const uiOnly = message('ui-only-thinking', 'ui-only-thinking', 7);
    const persisted = {...message('ui-with-tool', 'segment-two', 8), payload: {...message('unused').payload, toolCalls: [{...tool, arguments: {query: 'synthetic safe'}, result: {ok: true}}]}};
    const next = projectConversationTimeline([old, uiOnly, persisted], {
      ...turn, segmentId: 'segment-two', reasoning: '', toolCalls: [tool],
      segments: [{segmentId: 'segment-one', text: '', reasoning: 'thought fixture'}],
    });
    expect(next.messages.map(item => item.renderKey)).toEqual(['old-ui', 'live-turn-request-fixture']);
    expect(next.messages[1].payload.reasoningContent).toBe('thought fixture');
    expect(next.messages[1].payload.toolCalls).toHaveLength(1);
    expect(next.messages[1].payload.toolCalls[0].arguments).toEqual({query: 'synthetic safe'});
    expect(next.messages[1].preview).toBe(true);
    expect(projectConversationTimeline([message('older-loaded', 'older', 1), old], turn).messages[0].uiMessageId).toBe('older-loaded');
  });

  it('does not render a stale thought-only projection beside the richer projection of the SAME real message', () => {
    const thought = message('thinking-ui', 'same-message');
    const tool = {...message('tool-ui', 'same-message', 2), payload: {...thought.payload, toolCalls: [{id: 'tool-id', name: 'safe_tool', status: 'finished', result: 'safe result'}]}};
    const projected = projectConversationTimeline([thought, tool], null).messages;
    expect(projected.map(item => item.uiMessageId)).toEqual(['tool-ui']);
    expect(projected[0].payload.toolCalls).toHaveLength(1);
    const independent = {...thought, uiMessageId: 'different-ui', payload: {...thought.payload, content: 'independent text'}};
    expect(projectConversationTimeline([independent, tool], null).messages).toHaveLength(2);

    // Textually similar but different real messages must not be deduplicated.
    expect(projectConversationTimeline([thought, {...tool, messageId: 'another-message'}], null).messages).toHaveLength(2);
  });


  it('hands off identity but not live payload to a real durable target; deleted content is never recreated', () => {
    const durable = {...message('durable-ui', 'segment-one'), payload: {...message('unused').payload, content: 'edited durable text'}};
    const turn: NonNullable<LiveTurn> = {requestId: 'request-fixture', segmentId: 'segment-one', text: 'stale live text', reasoning: '', terminal: true, historyLoaded: true, handoffUiMessageId: 'durable-ui'};
    const final = projectConversationTimeline([durable], turn).messages;
    expect(final).toHaveLength(1);
    expect(final[0].renderKey).toBe('live-turn-request-fixture');
    expect(final[0].uiMessageId).toBe('durable-ui');
    expect(final[0].preview).not.toBe(true);
    expect(final[0].payload.content).toBe('edited durable text');
    expect(projectConversationTimeline([], turn).messages).toEqual([]);
    const other = message('other-ui', 'segment-one');
    expect(projectConversationTimeline([other], turn).messages[0].renderKey).toBe('other-ui');
  });
});
