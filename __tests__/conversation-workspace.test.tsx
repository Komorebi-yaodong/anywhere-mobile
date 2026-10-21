import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {useConversationWorkspace} from '../src/hooks/useConversationWorkspace';
import type {DesktopStatus} from '../src/domain/pairing';
import type {RemoteRequest, RemoteTrackedRequest} from '../src/remote/api';
import type {RemoteEventMessage} from '../src/remote/client';

const A = 'conversation-workspace-fixture-0001';
const B = 'conversation-workspace-fixture-0002';
const desktopId = 'desktop-workspace-fixture-0001';
const summary = (id: string) => ({conversationId: id, title: id, readable: true});
const page = (id: string, content = id) => ({
  conversation: {conversationId: id},
  messages: [{uiMessageId: `message-${id}`, order: 1, payload: {content}}],
  page: {pageSize: 50, nextBeforeUiOrder: null, hasMore: false},
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture() {
  let latest!: ReturnType<typeof useConversationWorkspace>;
  let listener: ((id: string, event: RemoteEventMessage) => void) | undefined;
  const response = deferred<unknown>();
  const rpc = jest.fn(async (id: string, method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'conversation.list') return {
      configured: true, conversations: [summary(A), summary(B)],
      page: {limit: 100, nextCursor: null, hasMore: false},
    };
    if (method === 'conversation.messages.list') return page(String(params?.conversationId));
    if (method === 'conversation.opened.list') return {
      ok: true,
      sessions: [A, B].map(conversationId => ({
        conversationId,
        title: conversationId,
        windowId: `window-${conversationId}`,
        visible: false,
        busy: false,
        mobileControlled: true,
        controlledByThisDevice: true,
        hidden: true,
        hasDesktopObserver: false,
      })),
    };
    if (method === 'conversation.open') return {
      ok: true,
      conversationId: String(params?.conversationId),
      windowId: `window-${String(params?.conversationId)}`,
      created: false,
      mobileControlled: true,
      observingDesktop: false,
    };
    if (method === 'conversation.request.get') return {
      requestId: 'request-workspace-fixture-0001', conversationId: A,
      text: 'recovered', reasoning: 'reason', eventSequence: 4,
      terminal: false, event: 'assistant.delta', truncated: false,
    };
    return {};
  });
  const request: RemoteRequest = rpc as RemoteRequest;
  const tracked: RemoteTrackedRequest = jest.fn(() => ({
    requestId: 'request-workspace-fixture-0001', response: response.promise,
  })) as RemoteTrackedRequest;
  const subscribeEvents = (callback: typeof listener) => {
    listener = callback;
    return () => { listener = undefined; };
  };
  function Harness({status}: {status: DesktopStatus}) {
    latest = useConversationWorkspace({
      desktopId, desktopStatus: status, request,
      requestTracked: tracked, subscribeEvents,
    });
    return null;
  }
  return {
    Harness, rpc, tracked, response,
    get state() { return latest; },
    emit(event: string, sequence: number, extra: Record<string, unknown> = {}) {
      listener?.(desktopId, {kind: 'event', event, payload: {
        requestId: 'request-workspace-fixture-0001', conversationId: A,
        eventSequence: sequence, ...extra,
      }});
    },
  };
}

describe('conversation workspace state boundaries', () => {

  it('becomes read-only after Desktop control changes without releasing or reopening the Writer', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    expect(f.state.canControlConversation(A)).toBe(true);
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.opened.list'
      ? Promise.resolve({ok: true, sessions: [{conversationId: A, controlledByThisDevice: false, mobileControlled: false, visible: true}]})
      : base(id, method, params));
    await act(async () => f.emit('conversation.windows.changed', 1));
    expect(f.state.canControlConversation(A)).toBe(false);
    await expect(f.state.sendMessage('blocked after takeover')).rejects.toThrow();
    expect(f.tracked).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });


  it('promotes queued early stream events before ACK and never overwrites its text', async () => {
    const f=fixture();
    let sequence=0;
    const replies=[deferred<unknown>(),deferred<unknown>()];
    (f.tracked as jest.Mock).mockImplementation(()=>{const index=sequence++;return {requestId:`request-queue-fixture-${index}`,response:replies[index].promise};});
    let root!:TestRenderer.ReactTestRenderer;
    await act(async()=>{root=TestRenderer.create(<f.Harness status="在线"/>)});
    let first!:Promise<void>,second!:Promise<void>;
    await act(async()=>{first=f.state.sendMessage('first');});
    await act(async()=>{replies[0].resolve({ok:true});await first;});
    await act(async()=>{second=f.state.sendMessage('second');});
    expect(f.state.queuedSends).toHaveLength(1);
    await act(async()=>{f.emit('assistant.delta',1,{requestId:'request-queue-fixture-1',textDelta:'early queued reply'});});
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn?.text).toBe('early queued reply');
    await act(async()=>{replies[1].resolve({ok:true,queued:true,position:1});await second;});
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn?.text).toBe('early queued reply');
    expect(f.state.queuedSends).toHaveLength(0);
    await act(async()=>root.unmount());
  });

  it('keeps Desktop history during reask until an authoritative page replaces it', async () => {
    const f = fixture();
    const oldPage = {...page(A), messages: [{uiMessageId: 'old-reply', role: 'assistant', order: 1, payload: {content: 'old error'}}]};
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A
      ? Promise.resolve(oldPage) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let reask!: Promise<void>;
    await act(async () => { reask = f.state.reaskLastAssistant('old-reply'); });
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['old-reply']);
    expect(f.tracked).toHaveBeenCalledWith(desktopId, 'conversation.message.reask', {conversationId: A, uiMessageId: 'old-reply'}, 30_000);
    await act(async () => { f.emit('assistant.delta', 1, {textDelta: 'new reply'}); });
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['old-reply']);
    oldPage.messages = [{uiMessageId: 'new-reply', role: 'assistant', order: 1, payload: {content: 'new reply'}}];
    await act(async () => { f.response.resolve({ok: true}); await reask; f.emit('assistant.completed', 2); });
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['new-reply']);
    expect(f.state.activeTurn?.historyLoaded).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('restores a cached reask reply when Desktop refuses dispatch', async () => {
    const f = fixture();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A
      ? Promise.resolve({...page(A), messages: [{uiMessageId: 'old-reply', role: 'assistant', order: 1, payload: {content: 'old'}}]}) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let result!: Promise<unknown>;
    await act(async () => { result = f.state.reaskLastAssistant('old-reply').catch(error => error); });
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['old-reply']);
    await act(async () => { f.response.reject(Object.assign(new Error('busy'), {code: 'remote_conversation_busy'})); await result; });
    expect(f.state.messages[0].uiMessageId).toBe('old-reply');
    expect(f.state.activeTurn?.terminal).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('creates with the selected assistant, selects the saved conversation and rejects double clicks', async () => {
    const f = fixture();
    const created = deferred<unknown>();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.create' ? created.promise : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let pending!: Promise<void>;
    await act(async () => { pending = f.state.createConversation('Code'); });
    await expect(f.state.createConversation('Code')).rejects.toThrow('重复');
    const cid = 'conversation-created-fixture-0001';
    await act(async () => { created.resolve({ok: true, conversationId: cid, title: 'Code - 新会话', promptCode: 'Code'}); await pending; });
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.create', {promptCode: 'Code'}, 60_000);
    expect(f.state.selectedConversationId).toBe(cid);
    expect(f.state.selectedConversation?.title).toBe('Code - 新会话');
    await act(async () => { root.unmount(); });
  });


  it('refreshes persisted user history as soon as Desktop starts the assistant', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('show without manual refresh'); });
    const before = f.rpc.mock.calls.filter(call => call[1] === 'conversation.messages.list').length;
    await act(async () => {
      f.emit('assistant.started', 1);
      await Promise.resolve();
    });
    expect(f.rpc.mock.calls.filter(call => call[1] === 'conversation.messages.list').length).toBeGreaterThan(before);
    await act(async () => { f.response.resolve({ok: true}); await send; root.unmount(); });
  });

  it('resends only the final user message through reask without creating a duplicate user message', async () => {
    const f = fixture();
    const userPage = {...page(A), messages: [{uiMessageId: 'user-final', role: 'user', order: 1, payload: {content: 'persisted user', attachments: [{id: 'attachment-fixture'}]}}]};
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A ? Promise.resolve(userPage) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let resend!: Promise<void>;
    await act(async () => { resend = f.state.resendLastUser('user-final'); });
    expect(f.tracked).toHaveBeenCalledWith(desktopId, 'conversation.message.reask', {conversationId: A, uiMessageId: 'user-final'}, 30_000);
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['user-final']);
    await act(async () => { f.response.resolve({ok: true}); await resend; f.emit('assistant.completed', 1); });
    await expect(f.state.resendLastUser('not-final')).rejects.toThrow('仅允许重发送最后一条用户消息');
    await act(async () => { root.unmount(); });
  });


  it('creates and updates a live tool-only assistant turn before any content delta', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('tool only fixture'); });
    await act(async () => {
      f.emit('assistant.delta', 1, {segmentId: 'assistant-tool-segment', toolCalls: [{id: 'tool-live-fixture', name: 'safe_tool', status: 'executing', arguments: '[参数已隐藏]'}]});
    });
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn).toMatchObject({text: '', reasoning: '', segmentId: 'assistant-tool-segment'});
    expect(f.state.activeTurn?.toolCalls).toEqual([{id: 'tool-live-fixture', name: 'safe_tool', status: 'executing', arguments: '[参数已隐藏]'}]);
    await act(async () => {
      f.emit('assistant.delta', 2, {segmentId: 'assistant-tool-segment', toolCalls: [{id: 'tool-live-fixture', name: 'safe_tool', status: 'finished', arguments: '[参数已隐藏]'}]});
    });
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn?.toolCalls?.[0]).toMatchObject({status: 'finished', arguments: '[参数已隐藏]'});
    await act(async () => { f.response.resolve({ok: true}); await send; root.unmount(); });
  });



  it('never replaces Desktop message boundaries with stream tools, even at terminal', async () => {
    const f = fixture();
    const base = f.rpc.getMockImplementation()!;
    const payload = {content: '', reasoningContent: 'Desktop reasoning', toolCalls: []};
    const rows = [
      {messageId: 'shared-canonical', uiMessageId: 'ui-one', role: 'assistant', order: 1, payload: {...payload, toolCalls: [{id: 'one', name: 'one', status: 'finished'}]}},
      {messageId: 'shared-canonical', uiMessageId: 'ui-two', role: 'assistant', order: 2, payload: {...payload, toolCalls: [{id: 'two', name: 'two', status: 'executing'}]}},
    ];
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A ? Promise.resolve({...page(A), messages: rows}) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    const before = f.state.messages;
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('fixture'); });
    await act(async () => {
      for (let index = 1; index <= 20; index += 1) f.emit('assistant.delta', index, {segmentId: `stream-${index}`, reasoningDelta: 'must not become a bubble', toolCalls: [{id: `new-${index}`, name: 'not-in-page', status: 'executing'}]});
    });
    expect(f.state.messages).toBe(before);
    expect(f.state.messages.map(message => message.uiMessageId)).toEqual(['ui-one', 'ui-two']);
    expect(f.state.messages.map(message => message.payload.toolCalls.map(call => call.id))).toEqual([['one'], ['two']]);
    await act(async () => { f.response.resolve({ok: true}); await send; f.emit('assistant.completed', 21); });
    expect(f.state.messages).toBe(before);
    expect(f.state.messages).toEqual(rows);
    await act(async () => root.unmount());
  });


  it('does not publish React updates per token while the authoritative history read is throttled', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('fixture'); });
    const snapshot = f.state;
    await act(async () => {
      for (let index = 1; index <= 50; index += 1) f.emit('assistant.delta', index, {textDelta: 'x'});
    });
    expect(f.state).toBe(snapshot);
    expect(f.state.messages).toBe(snapshot.messages);
    await act(async () => { f.response.resolve({ok: true}); await send; f.emit('assistant.completed', 51); });
    expect(f.state.activeTurn?.terminal).toBe(true);
    await act(async () => root.unmount());
  });


  it('refreshes the final Desktop page for an observed request that was not sent by this Mobile', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    const before = f.rpc.mock.calls.filter(call => call[1] === 'conversation.messages.list').length;
    await act(async () => { f.emit('assistant.completed', 1, {requestId: 'desktop-observed-request'}); });
    expect(f.rpc.mock.calls.filter(call => call[1] === 'conversation.messages.list').length).toBeGreaterThan(before);
    expect(f.state.activeTurn).toBeNull();
    await act(async () => root.unmount());
  });


  it('tracks only current segment progress without accumulating a second timeline', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('segment fixture'); });
    await act(async () => {
      f.emit('assistant.delta', 1, {
        textDelta: 'first answer', reasoningDelta: 'first thinking', segmentId: 'assistant-segment-one',
      });
      f.emit('assistant.delta', 2, {
        textDelta: 'second answer', reasoningDelta: 'second thinking', segmentId: 'assistant-segment-two',
      });
    });
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn).toMatchObject({
      segmentId: 'assistant-segment-two', text: 'second answer', reasoning: 'second thinking', historyLoaded: false,
    });
    await act(async () => { f.response.resolve({ok: true}); await send; root.unmount(); });
  });


  it('applies early stream events once and refreshes persisted history on terminal', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('hello'); });
    await act(async () => {
      f.emit('assistant.delta', 1, {textDelta: 'first'});
      f.emit('assistant.delta', 1, {textDelta: 'duplicate'});
    });
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn?.text).toBe('first');
    await act(async () => {
      f.response.resolve({ok: true});
      await send;
      f.emit('assistant.completed', 2);
      f.emit('assistant.delta', 3, {textDelta: 'late'});
    });
    expect(f.state.activeTurn).toMatchObject({text: 'first', terminal: true});
    expect(f.rpc.mock.calls.filter(call => call[1] === 'conversation.messages.list').length).toBeGreaterThan(1);
    await act(async () => { root.unmount(); });
  });

  it('retires terminal preview even when the final history is empty, and deletion invalidates a pending read', async () => {
    const f = fixture();
    const base = f.rpc.getMockImplementation()!;
    let rows: Array<Record<string, unknown>> = [{messageId: 'assistant-segment', uiMessageId: 'real-assistant', role: 'assistant', order: 1, payload: {content: 'saved'}}];
    let pendingPage: ReturnType<typeof deferred<unknown>> | undefined;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A
      ? pendingPage?.promise || Promise.resolve({...page(A), messages: rows}) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('fixture'); f.emit('assistant.delta', 1, {segmentId: 'assistant-segment', textDelta: 'live'}); });
    await act(async () => { f.response.resolve({ok: true}); await send; f.emit('assistant.completed', 2); });
    expect(f.state.activeTurn?.historyLoaded).toBe(true);
    pendingPage = deferred<unknown>();
    let refresh!: Promise<void>;
    await act(async () => { refresh = f.state.refreshMessages(); f.state.removeMessageFromView('real-assistant'); });
    expect(f.state.messages).toEqual([]);
    await act(async () => { pendingPage!.resolve({...page(A), messages: rows}); await refresh; });
    expect(f.state.messages).toEqual([]);
    pendingPage = undefined;
    rows = [];
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.activeTurn?.historyLoaded).toBe(true);
    expect(f.state.messages).toEqual([]);
    await act(async () => root.unmount());
  });


  it('keeps uncertain work after disconnect and queries its original request on reconnect', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let send!: Promise<void>;
    await act(async () => { send = f.state.sendMessage('one send only'); });
    await act(async () => {
      root.update(<f.Harness status="离线" />);
      f.response.reject(Object.assign(new Error('closed'), {code: 'remote_client_closed'}));
      await send;
    });
    expect(f.state.activeTurn?.terminal).toBe(false);
    await act(async () => { root.update(<f.Harness status="在线" />); });
    expect(f.state.activeTurn).toMatchObject({text: 'recovered', reasoning: 'reason', eventSequence: 4});
    expect(f.tracked).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.request.get', {
      requestId: 'request-workspace-fixture-0001',
    });
    await act(async () => { root.unmount(); });
  });

  it('retains loaded messages offline and forbids a duplicate send while disconnected', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    const previous = f.state.messages;
    await act(async () => { root.update(<f.Harness status="离线" />); });
    expect(f.state.messages).toEqual(previous);
    await expect(f.state.sendMessage('must not send')).rejects.toThrow('连接正在恢复');
    expect(f.tracked).not.toHaveBeenCalled();
    await act(async () => { root.update(<f.Harness status="在线" />); });
    expect(f.state.messages).toEqual(previous);
    await act(async () => root.unmount());
  });


  it('rejects stale history pages after switching conversations', async () => {
    const f = fixture();
    const stale = deferred<unknown>();
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) =>
      method === 'conversation.messages.list' && params?.conversationId === A
        ? stale.promise : base(id, method, params),
    );
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    await act(async () => { f.state.selectConversation(B); });
    await act(async () => { stale.resolve(page(A, 'stale')); });
    expect(f.state.messages[0].payload.content).toBe(B);
    await act(async () => { root.unmount(); });
  });

  it('retains already loaded older rows and their pagination cursor when refreshing the latest page', async () => {
    const f = fixture();
    const base = f.rpc.getMockImplementation()!;
    const row = (order: number) => ({uiMessageId: `ui-${order}`, messageId: `stored-${order}`, role: 'user', order, payload: {content: `fixture-${order}`}});
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A
      ? Promise.resolve(params?.beforeUiOrder
        ? {...page(A), messages: [row(1), row(2)], page: {pageSize: 50, nextBeforeUiOrder: 1, hasMore: false}}
        : {...page(A), messages: [row(3), row(4)], page: {pageSize: 50, nextBeforeUiOrder: 3, hasMore: true}})
      : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    await act(async () => { await f.state.loadOlderMessages(); });
    expect(f.state.messages.map(item => item.order)).toEqual([1, 2, 3, 4]);
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.messages.map(item => item.order)).toEqual([1, 2, 3, 4]);
    expect(f.state.messagePage.hasMore).toBe(false);
    expect(f.state.messagePage.nextBeforeUiOrder).toBe(1);
    await act(async () => root.unmount());
  });


  it('deletes only the exact confirmed UI ID, never guesses aliases from shared canonical IDs', async () => {
    const f = fixture();
    const payload = {content: '', reasoningContent: 'same reasoning', toolCalls: []};
    const rows = [
      {messageId: 'same-message', uiMessageId: 'thought-ui', role: 'assistant', order: 1, payload},
      {messageId: 'same-message', uiMessageId: 'tool-ui', role: 'assistant', order: 2, payload: {...payload, toolCalls: [{id: 'tool', name: 'tool', status: 'finished'}]}},
      {messageId: 'different-message', uiMessageId: 'keep-ui', role: 'assistant', order: 3, payload},
    ];
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A ? Promise.resolve({...page(A), messages: rows}) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    await act(async () => f.state.removeMessageFromView('tool-ui'));
    expect(f.state.messages.map(message => message.uiMessageId)).toEqual(['thought-ui', 'keep-ui']);
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.messages.map(message => message.uiMessageId)).toEqual(['thought-ui', 'keep-ui']);
    await act(async () => root.unmount());
  });


  it('keeps a confirmed deletion hidden when a stale history refresh arrives', async () => {
    const f = fixture();
    const stalePage = {...page(A), messages: [{uiMessageId: 'deleted-ui', role: 'user', order: 1, payload: {content: 'must stay hidden'}}]};
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A ? Promise.resolve(stalePage) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    expect(f.state.messages.map(item => item.uiMessageId)).toEqual(['deleted-ui']);
    await act(async () => { f.state.removeMessageFromView('deleted-ui'); });
    expect(f.state.messages).toEqual([]);
    await act(async () => { await f.state.refreshMessages(); });
    expect(f.state.messages).toEqual([]);
    await act(async () => { root.unmount(); });
  });


  it('keeps an opened session selected when it is outside the current catalog page', async () => {
    const f = fixture();
    const openedOnly = 'conversation-opened-only-fixture-0003';
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    await act(async () => { f.state.selectConversation(openedOnly, 'Opened Only'); });
    await act(async () => { await Promise.resolve(); });
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.open', {conversationId: openedOnly}, 30_000);
    expect(f.rpc.mock.calls.some(call => call[1] === 'conversation.takeover')).toBe(false);
    expect(f.state.selectedConversationId).toBe(openedOnly);
    expect(f.state.selectedConversation?.title).toBe('Opened Only');
    await act(async () => { await f.state.refreshCatalog(); });
    expect(f.state.selectedConversationId).toBe(openedOnly);
    expect(f.state.selectedConversation?.title).toBe('Opened Only');
    await act(async () => { root.unmount(); });
  });


  it('releases an idle hidden writer when switching or leaving a conversation', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    await act(async () => { f.state.selectConversation(B); });
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.release', {conversationId: A}, 15_000);
    await act(async () => { f.state.releaseSelectedConversation(); });
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.release', {conversationId: B}, 15_000);
    await act(async () => { root.unmount(); });
  });

  it('exposes ask_user_choice immediately and submits custom or discuss responses without refresh', async () => {
    const f = fixture();
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    const toolCallId = 'tool-choice-fixture-0001';
    await act(async () => {
      f.emit('conversation.choice.required', 1, {
        toolCallId,
        questions: [{
          question: 'Choose', header: 'Please choose',
          options: [{label: 'A', description: 'Option A'}],
        }],
      });
    });
    expect(f.state.pendingChoices[toolCallId]).toMatchObject({conversationId: A});
    await act(async () => {
      await f.state.submitChoice(toolCallId, [{questionIndex: 0, type: 'custom', customText: 'My idea', question: 'Choose'}]);
    });
    expect(f.rpc).toHaveBeenCalledWith(desktopId, 'conversation.choice.submit', {
      conversationId: A,
      toolCallId,
      responses: [{questionIndex: 0, type: 'custom', customText: 'My idea', question: 'Choose'}],
    }, 60_000);
    expect(f.state.pendingChoices[toolCallId]).toBeUndefined();
    await act(async () => { root.unmount(); });
  });

});
