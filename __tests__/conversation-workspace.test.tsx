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
    expect(f.state.activeTurn?.text).toBe('early queued reply');
    await act(async()=>{replies[1].resolve({ok:true,queued:true,position:1});await second;});
    expect(f.state.activeTurn?.text).toBe('early queued reply');
    expect(f.state.queuedSends).toHaveLength(0);
    await act(async()=>root.unmount());
  });

  it('replaces a reasked reply immediately and reconciles persisted history without switching', async () => {
    const f = fixture();
    const oldPage = {...page(A), messages: [{uiMessageId: 'old-reply', role: 'assistant', order: 1, payload: {content: 'old error'}}]};
    const base = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((id, method, params) => method === 'conversation.messages.list' && params?.conversationId === A
      ? Promise.resolve(oldPage) : base(id, method, params));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => { root = TestRenderer.create(<f.Harness status="在线" />); });
    let reask!: Promise<void>;
    await act(async () => { reask = f.state.reaskLastAssistant('old-reply'); });
    expect(f.state.messages).toEqual([]);
    expect(f.tracked).toHaveBeenCalledWith(desktopId, 'conversation.message.reask', {conversationId: A, uiMessageId: 'old-reply'}, 30_000);
    await act(async () => { f.emit('assistant.delta', 1, {textDelta: 'new reply'}); });
    expect(f.state.messages).toEqual([]);
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
    expect(f.state.messages).toHaveLength(0);
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
