import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {AppState, Text} from 'react-native';
import {WorkspaceShell} from '../src/components/WorkspaceShell';
import {ConversationMessageList} from '../src/components/ConversationMessageList';
import {ConversationMenu} from '../src/components/ConversationMenu';
import {createBusinessRouter} from '../src/remote/businessRouter';

import type {DesktopRuntime} from '../src/hooks/useDesktops';
import type {RemoteRequest, RemoteTrackedRequest, ConversationSummary} from '../src/remote/api';

// Real Shell + real workspace hook. Only unrelated native media is replaced.
jest.mock('../src/hooks/useAudioRecording', () => ({useAudioRecording: () => ({recording: false, processing: false, cancel: jest.fn()})}));
jest.mock('../src/hooks/useAttachmentQueue', () => ({useAttachmentQueue: () => ({uploads: [], busy: false, markSubmitted: jest.fn()})}));
jest.mock('../src/services/remoteImageCache', () => ({cacheRemoteImage: jest.fn(async () => '')}));
const A = 'conversation-integration-old-001', C = 'conversation-integration-new-001';
function deferred() {let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(yes => {resolve = yes;}); return {promise, resolve};}
function button(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root.findAllByType(Text).find(node => node.props.children === label);
  let node = text?.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}
function fixture(opened: boolean) {
  const admitted = deferred(), completed = deferred();
  let created = false, moved = false;
  let pendingQueries = 0;
  const queryRouter = createBusinessRouter(async method => {
    if (method === 'remote.contract.negotiate') return {selected: {major: 1, minor: 1}, capabilities: ['command.durable.v1'], serverEpoch: 'integration', limits: {eventRetention: 512, operationRetentionMs: 1800000}};
    if (method !== 'operation.status.get') throw new Error('Unexpected query');
    const base = {operationId: 'create-integration-command', code: null, acceptedAt: 100, expiresAt: 10000, receipt: null};
    if (pendingQueries++ === 0) return {...base, conversationId: null, state: 'running', terminal: false,
      progress: {requestId: base.operationId, conversationId: null, terminal: false, event: 'conversation.command.pending', eventSequence: 0}};
    const final = await completed.promise as {result: Record<string, unknown>};
    return {...base, conversationId: C, state: 'succeeded', terminal: true,
      progress: {requestId: base.operationId, conversationId: C, terminal: true, event: 'conversation.operation.completed', result: final.result}};
  });
  queryRouter.welcome(['remote.contract.negotiate']);

  const summary = (id: string) => ({conversationId: id, title: id === A ? 'Old chat' : 'New chat', readable: true, project: moved && id === A ? {projectId: 'target-project', name: 'Target'} : null});
  const session = {conversationId: A, title: 'Old chat', windowId: 'window-integration-old', hidden: true, controlledByThisDevice: true, mobileControlled: true, busy: false};
  const rpc = jest.fn(async (_id: string, method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'workspace.bootstrap.get') return {ok: true, configured: true, profile: {displayName: 'Synthetic'}, projects: [{projectId: 'target-project', name: 'Target'}], assistants: []};
    if (method === 'conversation.assistants.list') return {assistants: [{code: 'Code', name: 'Create Synthetic', icon: ''}]};
    if (method === 'workspace.assistants.list') return {assistants: []};
    if (method === 'conversation.list') return {configured: true, conversations: created ? [summary(C), summary(A)] : [summary(A)], page: {hasMore: false, nextCursor: null, limit: 100}};
    if (method === 'conversation.opened.list') return {sessions: opened ? [session] : []};
    if (method === 'conversation.messages.list') return {conversation: {conversationId: params?.conversationId}, messages: params?.conversationId === A ? [{uiMessageId: 'old-message', role: 'user', order: 1, payload: {content: 'OLD CONTENT MUST NOT BE NEW CHAT'}}] : [], page: {hasMore: false, nextBeforeUiOrder: null, pageSize: 50}};
    if (method === 'conversation.open') return {mobileControlled: true};
    if (method === 'remote.status.get') return {capabilities: ['conversation.project.set', 'conversation.delete']};
    if (method === 'conversation.request.get') return params?.requestId === 'create-integration-command' ? queryRouter.route(method, params!, 20000, 'poll-create-fixture', Date.now()) : {terminal: true, event: 'conversation.operation.completed', result: {}};
    return {};
  });
  const tracked = jest.fn((_id: string, method: string) => {
    if (method === 'conversation.create') return {requestId: 'create-integration-command', response: admitted.promise};
    moved = true;
    return {requestId: 'move-integration-command', response: Promise.resolve({accepted: true})};
  });
  let events: ((id: string, event: any) => void) | undefined;
  const props = {desktop: {id: 'desktop-integration-fixture', name: 'Synthetic', status: '在线'} as DesktopRuntime, request: rpc as RemoteRequest, requestTracked: tracked as RemoteTrackedRequest,
    subscribeEvents: (listener: typeof events) => {events = listener; return () => {events = undefined;};}, onHome: jest.fn()};
  return {props, rpc, tracked, admitted, completed, complete() {created = true; completed.resolve({terminal: true, event: 'conversation.operation.completed', result: {conversationId: C, title: 'New chat', promptCode: 'Code'}});}, windowsChanged() {events?.(props.desktop.id, {kind: 'event', event: 'conversation.windows.changed', payload: {}});}};
}
beforeEach(() => {jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({remove: jest.fn()}));});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('never renders old chat on accepted create with opened=%s, then navigates only to real ID', async opened => {
  const f = fixture(opened);let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...f.props} />);});
  if (opened) await act(async () => {root.root.findAll(node => node.props.accessibilityRole === 'tab' && node.props.accessibilityLabel === '新的聊天' && typeof node.props.onPress === 'function')[0].props.onPress();});
  await act(async () => {button(root, 'Create Synthetic').props.onPress();});
  expect(root.root.findAllByType(ConversationMessageList)).toHaveLength(0);
  await act(async () => {f.admitted.resolve({accepted: true});});
  await act(async () => {f.windowsChanged();});
  expect(root.root.findAllByType(ConversationMessageList)).toHaveLength(0);
  await act(async () => {f.complete(); await new Promise<void>(resolve => setTimeout(resolve, 450));});
  const list = root.root.findByType(ConversationMessageList);
  expect(list.props.messages).toEqual([]);
  expect(f.rpc.mock.calls.filter(call => call[1] === 'conversation.request.get')).toHaveLength(2);
  expect(JSON.stringify(root.toJSON())).not.toContain('Desktop 执行状态尚待确认');

  expect(f.rpc.mock.calls.some(call => call[1] === 'conversation.open' && call[2]?.conversationId === C)).toBe(true);
  expect(f.tracked.mock.calls.filter(call => call[1] === 'conversation.create')).toHaveLength(1);
  await act(async () => root.unmount());
});

it('reloads catalog after moving an unopened long-pressed conversation, without opening it', async () => {
  const f = fixture(false);let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<WorkspaceShell {...f.props} />);});
  const drawer = root.root.findAll(node => typeof node.props.onConversationMenu === 'function')[0];
  const before = f.rpc.mock.calls.filter(call => call[1] === 'conversation.list').length;
  await act(async () => {drawer.props.onConversationMenu({conversationId: A, title: 'Old chat', readable: true} as ConversationSummary);});
  expect(root.root.findAllByType(ConversationMenu)).toHaveLength(1);
  const press = (label: string) => root.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0].props.onPress();
  await act(async () => {press('选择所属项目');});
  await act(async () => {press('项目 Target');});
  await act(async () => {press('保存到项目');});
  expect(f.rpc.mock.calls.filter(call => call[1] === 'conversation.list').length).toBeGreaterThan(before);
  expect(f.rpc.mock.calls.some(call => call[1] === 'conversation.open')).toBe(false);
  const updatedDrawer = root.root.findAll(node => typeof node.props.onConversationMenu === 'function')[0];
  expect(updatedDrawer.props.byProject.get('target-project')[0].conversationId).toBe(A);
  await act(async () => root.unmount());
});
