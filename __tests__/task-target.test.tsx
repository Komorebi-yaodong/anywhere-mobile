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
const saveLabel = '自动保存对话记录';
const showLabel = '在 Desktop 显示新会话窗口';
const hasText = (root: TestRenderer.ReactTestRenderer, label: string) => root.root.findAllByType(Text).some(node => node.props.children === label);
const projectLabel = '保存项目';
const ungroupedLabel = '不分组';


test('model ability is optional and shown only for the default Agent, never a custom Agent or conversation', async () => {
  const request = jest.fn(async () => ({ok: true, section: 'tasks', schema: [{key: 'name', type: 'text'}, {key: 'description', type: 'multiline'}, {key: 'enabled', type: 'boolean'}, {key: 'promptKey', type: 'assistant'}, {key: 'conversationId', type: 'conversation'}, {key: 'triggerType', type: 'select'}, {key: 'dailyTime', type: 'time'}], options: {assistant: [{value: '__DEFAULT__', label: '默认助手'}, {value: 'Code', label: 'Code'}]}, items: []}));
  let root!: TestRenderer.ReactTestRenderer;
  try {
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
  } finally {if (root) await act(async () => root.unmount());}
});


test('selects an existing conversation mutually exclusively and saves its ID without local paths', async () => {
  const request = jest.fn(async (_id: string, method: string) => method === 'management.catalog' ? {
    ok: true, section: 'tasks', schema: [{key: 'name', type: 'text'}, {key: 'description', type: 'multiline'}, {key: 'enabled', type: 'boolean'}, {key: 'promptKey', type: 'assistant'}, {key: 'conversationId', type: 'conversation'}, {key: 'triggerType', type: 'select'}, {key: 'dailyTime', type: 'time'}, {key: 'autoSave', type: 'boolean'}, {key: 'autoSaveProjectId', type: 'project'}, {key: 'showWindow', type: 'boolean'}], options: {assistant: [{value: '__DEFAULT__', label: '默认助手'}], conversation: [{value: 'conversation-target-fixture', label: 'Existing conversation'}]}, items: [],
  } : {ok: true});
  let root!: TestRenderer.ReactTestRenderer;
  try {
  await act(async () => {root = TestRenderer.create(<TaskSettings desktopId="fixture" request={request as RemoteRequest} onChanged={() => undefined} refreshSignal={0} />);});
  await act(async () => button(root, '新建定时任务').props.onPress());
  await act(async () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '例如：每日整理')!.props.onChangeText('Target task'));
  expect(hasText(root, saveLabel)).toBe(true);
  expect(hasText(root, '保存项目')).toBe(true);
  await act(async () => button(root, showLabel).props.onPress());
  await act(async () => button(root, '目标类型').props.onPress());
  expect(hasText(root, saveLabel)).toBe(false);
  expect(hasText(root, '保存项目')).toBe(false);
  await act(async () => button(root, '目标会话').props.onPress());
  await act(async () => button(root, 'Existing conversation').props.onPress());
  await act(async () => button(root, '确定').props.onPress());
  await act(async () => button(root, '保存任务').props.onPress());
  const call = request.mock.calls.find(item => item[1] === 'management.mutate') as unknown as [string, string, {patch: Record<string, unknown>}];
  expect(call[2].patch.promptKey).toBe('');
  expect(call[2].patch.conversationId).toBe('conversation-target-fixture');
  expect(call[2].patch.showWindow).toBe(false);
  expect(call[2].patch).not.toHaveProperty('autoSave');
  expect(call[2].patch).not.toHaveProperty('autoSaveProjectId');
  expect(call[2].patch).not.toHaveProperty('dirPath');
  } finally {if (root) await act(async () => root.unmount());}
});

const storedTaskId = 'legacy-save-fixture';
const storedTaskName = '旧任务';
const storedTaskRevision = 'fixture-revision';
const storedSchema = [
  {key: 'name', type: 'text'}, {key: 'promptKey', type: 'assistant'},
  {key: 'conversationId', type: 'conversation'}, {key: 'autoSave', type: 'boolean'},
  {key: 'autoSaveProjectId', type: 'project'},
];

async function withStoredTask(value: Record<string, unknown>, schema: typeof storedSchema, run: (root: TestRenderer.ReactTestRenderer, mutations: Array<Record<string, unknown>>) => Promise<void>) {
  const mutations: Array<Record<string, unknown>> = [];
  const request = jest.fn(async (_id: string, method: string, params: Record<string, unknown> = {}) => {
    if (method === 'management.mutate') {
      mutations.push(params);
      return {ok: true};
    }
    if (method !== 'management.catalog') throw Error('remote_method_unavailable');
    const catalog = {
      ok: true, section: 'tasks', schema,
      options: {project: [{value: '', label: ungroupedLabel}, {value: 'saved-project', label: '原项目'}]},
      items: [{id: storedTaskId, name: storedTaskName, revision: storedTaskRevision, enabled: true}],
    };
    return params.id ? {...catalog, id: storedTaskId, revision: storedTaskRevision, value: {name: storedTaskName, ...value}} : catalog;
  });
  let root!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {root = TestRenderer.create(<TaskSettings desktopId="stored-task-fixture" request={request as RemoteRequest} onChanged={() => undefined} refreshSignal={0} />);});
    await act(async () => button(root, storedTaskName).props.onPress());
    expect(hasText(root, '编辑定时任务')).toBe(true);
    await run(root, mutations);
  } finally {if (root) await act(async () => root.unmount());}
}

function expectNoProject(root: TestRenderer.ReactTestRenderer) {
  expect(hasText(root, projectLabel)).toBe(false);
  expect(hasText(root, ungroupedLabel)).toBe(false);
}

test('editing a legacy conversation task ignores retained Agent save flags, including an ungrouped project', async () => {
  await withStoredTask({conversationId: 'existing-fixture', autoSave: true, autoSaveProjectId: ''}, storedSchema, async (root, mutations) => {
    expect(hasText(root, '本地会话')).toBe(true);
    expect(hasText(root, saveLabel)).toBe(false);
    expectNoProject(root);
    await act(async () => button(root, '目标类型').props.onPress());
    expect(hasText(root, projectLabel)).toBe(true);
    expect(hasText(root, ungroupedLabel)).toBe(true);
    await act(async () => button(root, '目标类型').props.onPress());
    expectNoProject(root);
    await act(async () => button(root, '保存任务').props.onPress());
    expect(mutations).toHaveLength(0);
    expect(hasText(root, '请选择目标会话。')).toBe(true);
  });
});

test('turning off Agent auto-save closes the project picker and submits only the save flag', async () => {
  await withStoredTask({promptKey: '__DEFAULT__', autoSave: true, autoSaveProjectId: 'saved-project'}, storedSchema, async (root, mutations) => {
    const turnOff = button(root, saveLabel).props.onPress;
    await act(async () => button(root, projectLabel).props.onPress());
    expect(hasText(root, ungroupedLabel)).toBe(true);
    await act(async () => turnOff());
    expectNoProject(root);
    expect(hasText(root, '确定')).toBe(false);
    await act(async () => button(root, saveLabel).props.onPress());
    expect(hasText(root, '原项目')).toBe(true);
    await act(async () => button(root, saveLabel).props.onPress());
    await act(async () => button(root, '保存任务').props.onPress());
    expect(mutations).toHaveLength(1);
    expect(mutations[0].patch).toMatchObject({autoSave: false});
    expect(mutations[0].patch).not.toHaveProperty('autoSaveProjectId');
  });
});

test('a server without the save control cannot expose or receive its dependent project field', async () => {
  await withStoredTask({promptKey: '__DEFAULT__', autoSave: true, autoSaveProjectId: 'saved-project'}, storedSchema.filter(field => field.key !== 'autoSave'), async (root, mutations) => {
    expect(hasText(root, saveLabel)).toBe(false);
    expectNoProject(root);
    await act(async () => button(root, '保存任务').props.onPress());
    expect(mutations).toHaveLength(1);
    expect(mutations[0].patch).not.toHaveProperty('autoSave');
    expect(mutations[0].patch).not.toHaveProperty('autoSaveProjectId');
  });
});


test('Agent can enable saving and select a project even on an older Desktop without the window setting', async () => {
  const schema = [
    {key: 'name', type: 'text'}, {key: 'promptKey', type: 'assistant'},
    {key: 'autoSave', type: 'boolean'}, {key: 'autoSaveProjectId', type: 'project'},
  ];
  const request = jest.fn(async (_id: string, method: string) => method === 'management.catalog' ? {
    ok: true, section: 'tasks', schema, options: {project: [{value: 'fixture-project', label: 'Fixture project'}]}, items: [],
  } : {ok: true});
  let root!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {root = TestRenderer.create(<TaskSettings desktopId="old-desktop-fixture" request={request as RemoteRequest} onChanged={() => undefined} refreshSignal={0} />);});
    await act(async () => button(root, '新建定时任务').props.onPress());
    await act(async () => root.root.findAllByType(TextInput).find(node => node.props.placeholder === '例如：每日整理')!.props.onChangeText('Agent task'));
    expect(hasText(root, showLabel)).toBe(false);
    await act(async () => button(root, saveLabel).props.onPress());
    expect(hasText(root, '保存项目')).toBe(false);
    await act(async () => button(root, saveLabel).props.onPress());
    await act(async () => button(root, '保存项目').props.onPress());
    await act(async () => button(root, 'Fixture project').props.onPress());
    await act(async () => button(root, '确定').props.onPress());
    await act(async () => button(root, '保存任务').props.onPress());
    const call = request.mock.calls.find(item => item[1] === 'management.mutate') as unknown as [string, string, {patch: Record<string, unknown>}];
    expect(call[2].patch).toMatchObject({autoSave: true, autoSaveProjectId: 'fixture-project'});
    expect(call[2].patch).not.toHaveProperty('showWindow');
  } finally {if (root) await act(async () => root.unmount());}
});
