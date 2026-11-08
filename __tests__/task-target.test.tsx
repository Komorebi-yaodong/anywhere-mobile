import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Text, TextInput} from 'react-native';
import {TaskSettings} from '../src/components/TaskSettings';
import type {RemoteRequest} from '../src/remote/api';

function button(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root.findAllByType(Text).find(node => node.props.children === label);
  let target = text?.parent;
  while (target && typeof target.props.onPress !== 'function') target = target.parent;
  if (!target) throw Error(`Missing button ${label}`);
  return target;
}
test('model ability is optional and shown only for the default Agent, never a custom Agent or conversation', async () => {
  const request = jest.fn(async () => ({ok: true, section: 'tasks', schema: [], options: {assistant: [{value: '__DEFAULT__', label: '默认助手'}, {value: 'Code', label: 'Code'}]}, items: []}));
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<TaskSettings desktopId="route-fixture" request={request as RemoteRequest} onChanged={() => undefined} refreshSignal={0} />);});
  await act(async () => button(root, '新建定时任务').props.onPress());
  const visible = () => root.root.findAllByType(Text).some(node => node.props.children === '模型能力（可选）');
  expect(visible()).toBe(true);
  await act(async () => button(root, '助手').props.onPress());
  await act(async () => button(root, 'Code').props.onPress());
  await act(async () => button(root, '确定').props.onPress());
  expect(visible()).toBe(false);
  await act(async () => button(root, '目标类型').props.onPress());
  expect(visible()).toBe(false);
  await act(async () => root.unmount());
});


test('selects an existing conversation mutually exclusively and saves its ID without local paths', async () => {
  const request = jest.fn(async (_id: string, method: string) => method === 'management.catalog' ? {
    ok: true, section: 'tasks', schema: [], options: {assistant: [{value: '__DEFAULT__', label: '默认助手'}], conversation: [{value: 'conversation-target-fixture', label: 'Existing conversation'}]}, items: [],
  } : {ok: true});
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {root = TestRenderer.create(<TaskSettings desktopId="fixture" request={request as RemoteRequest} onChanged={() => undefined} refreshSignal={0} />);});
  await act(async () => button(root, '新建定时任务').props.onPress());
  await act(async () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '例如：每日整理')!.props.onChangeText('Target task'));
  await act(async () => button(root, '目标类型').props.onPress());
  await act(async () => button(root, '目标会话').props.onPress());
  await act(async () => button(root, 'Existing conversation').props.onPress());
  await act(async () => button(root, '确定').props.onPress());
  await act(async () => button(root, '保存任务').props.onPress());
  const call = request.mock.calls.find(item => item[1] === 'management.mutate') as unknown as [string, string, {patch: Record<string, unknown>}];
  expect(call[2].patch.promptKey).toBe('');
  expect(call[2].patch.conversationId).toBe('conversation-target-fixture');
  expect(call[2].patch).not.toHaveProperty('dirPath');
  await act(async () => root.unmount());
});
