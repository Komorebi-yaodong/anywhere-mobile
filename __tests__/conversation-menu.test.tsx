import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert} from 'react-native';
import {ConversationMenu} from '../src/components/ConversationMenu';
import type {ConversationSummary, RemoteRequest, RemoteTrackedRequest} from '../src/remote/api';
const CID = 'conversation-menu-target-0001';
function fixture(capabilities = ['conversation.project.set', 'conversation.delete'], opened: unknown[] = []) {
  let deleted = false;
  const request = jest.fn(async (_id: string, method: string): Promise<unknown> => {
    if (method === 'remote.status.get') return {capabilities};
    if (method === 'conversation.opened.list') return {sessions: opened};
    if (method === 'conversation.request.get') return {terminal: true, event: 'conversation.operation.completed', result: {deleted}};
    return {};
  });
  const tracked = jest.fn((_id: string, method: string) => {deleted = method === 'conversation.delete'; return {requestId: 'menu-operation-fixture', response: Promise.resolve({ok: true})};});
  const completed = jest.fn();
  const props = {desktopId: 'desktop-menu-fixture', conversation: {conversationId: CID, title: '完整名称：项目长会话名称', readable: true, project: {projectId: 'old-project', name: '旧项目'}} as ConversationSummary,
    projects: [{projectId: 'new-project', name: '新项目'}] as any, request: request as RemoteRequest, requestTracked: tracked as RemoteTrackedRequest, onClose: jest.fn(), onCompleted: completed};
  return {request, tracked, completed, props};
}
function button(root: TestRenderer.ReactTestRenderer, label: string) {return root.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];}
async function render(props: React.ComponentProps<typeof ConversationMenu>) {let root!: TestRenderer.ReactTestRenderer; await act(async () => {root = TestRenderer.create(<ConversationMenu {...props} />);}); return root;}
it('shows full name and moves the exact long-pressed conversation to project or ungrouped', async () => {
  for (const project of ['新项目', '未分组']) {
    const f = fixture(); const root = await render(f.props);
    expect(JSON.stringify(root.toJSON())).toContain(f.props.conversation.title);
    await act(async () => button(root, '选择所属项目').props.onPress());

    await act(async () => button(root, `项目 ${project}`).props.onPress());
    await act(async () => button(root, '保存到项目').props.onPress());
    expect(f.tracked).toHaveBeenCalledWith('desktop-menu-fixture', 'conversation.project.set', {conversationId: CID, projectId: project === '新项目' ? 'new-project' : ''}, 30000);
    expect(f.completed).toHaveBeenCalledWith(false);
    await act(async () => root.unmount());
  }
});
it('uses a sorted project picker and places delete left of save in one row', async () => {
 const f = fixture(); f.props.projects = [{projectId: 'z', name: 'Zebra'}, {projectId: 'b10', name: 'Beta10'}, {projectId: 'b2', name: 'Beta2'}, {projectId: 'a', name: 'Alpha'}];
 const root = await render(f.props);
 expect(button(root, '删除会话').parent).toBe(button(root, '保存到项目').parent);
 expect(JSON.stringify(root.toJSON()).indexOf('删除会话')).toBeLessThan(JSON.stringify(root.toJSON()).indexOf('保存到项目'));
 await act(async () => button(root, '选择所属项目').props.onPress());
 const labels = root.root.findAll(node => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function').map(node => node.props.accessibilityLabel);
 expect(labels).toEqual(['项目 未分组', '项目 Alpha', '项目 Beta2', '项目 Beta10', '项目 Zebra']);
 await act(async () => root.unmount());
});


it('uses only the action button for updating progress with no duplicate confirmation notice', async () => {
 const f = fixture(); let resolve!: (value: unknown) => void;
 f.tracked.mockImplementation(() => ({requestId: 'menu-operation-fixture', response: new Promise(yes => {resolve = yes;}) as Promise<any>}));
 const root = await render(f.props);
 await act(async () => button(root, '选择所属项目').props.onPress());
 await act(async () => button(root, '项目 新项目').props.onPress());
 await act(async () => {button(root, '保存到项目').props.onPress();});
 const {Text} = require('react-native');
 expect(root.root.findAllByType(Text).filter(node => node.props.children === '正在更新')).toHaveLength(1);
 expect(JSON.stringify(root.toJSON())).not.toContain('正在等待');
 expect(root.root.findAll(node => node.props.accessibilityLabel === '会话操作提示')).toHaveLength(0);
 await act(async () => resolve({ok: true}));
 expect(f.completed).toHaveBeenCalledWith(false);
 await act(async () => root.unmount());
});


it('requires explicit destructive confirmation and deletes only the target conversation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const f = fixture(); const root = await render(f.props);
  await act(async () => button(root, '删除会话').props.onPress());
  expect(f.tracked).not.toHaveBeenCalled();
  expect(alert.mock.calls[0][1]).toContain(f.props.conversation.title);
  const confirmation = alert.mock.calls[0][2]!.find(item => item.style === 'destructive')!;
  await act(async () => confirmation.onPress!());
  expect(f.tracked).toHaveBeenCalledWith('desktop-menu-fixture', 'conversation.delete', {conversationId: CID, confirmed: true}, 30000);
  expect(f.completed).toHaveBeenCalledWith(true);
  await act(async () => root.unmount()); alert.mockRestore();
});
it('disables unsupported project change without disabling a supported delete', async () => {
  const f = fixture(['conversation.delete']); const root = await render(f.props);
  expect(button(root, '保存到项目').props.disabled).toBe(true);
  expect(button(root, '删除会话').props.disabled).toBe(false);
  expect(f.tracked).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
it.each([true, false])('blocks busy or foreign-controlled sessions without implicit takeover (busy=%s)', async busy => {
  const f = fixture(undefined, [{conversationId: CID, busy, controlledByThisDevice: false}]); const root = await render(f.props);
  expect(button(root, '删除会话').props.disabled).toBe(true);
  expect(button(root, '保存到项目').props.disabled).toBe(true);
  expect(f.request.mock.calls.some(call => call[1] === 'conversation.takeover')).toBe(false);
  await act(async () => root.unmount());
});
it('allows idle orphan hidden writers but never bypasses another mobile owner', async () => {
 for (const mobileControlled of [false, true]) {
  const f = fixture(undefined, [{conversationId: CID, busy: false, hidden: true, mobileControlled, controlledByThisDevice: false}]);
  const root = await render(f.props);
  expect(button(root, '删除会话').props.disabled).toBe(mobileControlled);
  expect(f.tracked).not.toHaveBeenCalled();
  await act(async () => root.unmount());
 }
});


it('keeps an uncertain operation recoverable and never dispatches it twice', async () => {
  jest.useFakeTimers();
  const f = fixture(); const base = f.request.getMockImplementation()!;
  f.request.mockImplementation((id, method) => method === 'conversation.request.get' ? Promise.reject(new Error('transient')) : base(id, method));
  const root = await render(f.props);
  await act(async () => button(root, '选择所属项目').props.onPress());

  await act(async () => button(root, '项目 新项目').props.onPress());
  await act(async () => button(root, '保存到项目').props.onPress());
  expect(f.completed).not.toHaveBeenCalled();
  expect(button(root, '保存到项目').props.disabled).toBe(true);
  expect(JSON.stringify(root.toJSON())).not.toContain('检查原操作结果');
  f.request.mockImplementation(base);
  await act(async () => {jest.advanceTimersByTime(2500);});
  expect(f.completed).toHaveBeenCalledWith(false);
  expect(f.tracked).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  jest.useRealTimers();
});
