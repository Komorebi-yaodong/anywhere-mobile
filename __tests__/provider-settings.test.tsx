import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {Alert, Text, TextInput} from 'react-native';

import {ProviderSettings} from '../src/components/ProviderSettings';
import type {RemoteRequest} from '../src/remote/api';

function press(root: TestRenderer.ReactTestRenderer, label: string) {
  const text = root.root.findAllByType(Text).find(node => node.props.children === label);
  let node = text?.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Missing pressable ${label}`);
  return node;
}

const catalog = {
  ok: true as const,
  folders: [{id: 'tools', name: '工具', collapsed: false}],
  options: {
    apiTypes: [
      {value: 'chat_completions' as const, label: 'Chat Completions'},
      {value: 'responses' as const, label: 'Responses'},
      {value: 'codex' as const, label: 'Codex'},
      {value: 'claude' as const, label: 'Claude'},
    ],
    folders: [{id: 'tools', name: '工具'}],
  },
  providers: [
    {
      id: 'fixture', name: 'Fixture Provider', enabled: true, url: 'https://provider.example.test/v1',
      apiType: 'chat_completions' as const, models: ['z-model'], retryCount: 3, folderId: 'tools',
      apiKeyCount: 2, headerNames: ['X-Existing'], revision: 'provider-revision-fixture',
    },
    {
      id: 'fixture-two', name: 'Fixture Provider Two', enabled: true, url: 'https://provider.example.test/v2', apiType: 'chat_completions' as const,
      models: [], retryCount: 2, folderId: 'tools', apiKeyCount: 0, headerNames: [], revision: 'provider-revision-fixture-two',
    },
    {
      id: 'root', name: 'Root Provider', enabled: false, url: '', apiType: 'responses' as const,
      models: [], retryCount: 2, folderId: '', apiKeyCount: 0, headerNames: [], revision: 'provider-revision-root',
    },
  ],
};

test('moves a provider down with an immediate scoped order mutation', async () => {
  const request = jest.fn(async (_desktopId: string, method: string) => {
    if (method === 'workspace.provider.catalog') return catalog;
    return {ok: true};
  });
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ProviderSettings
        desktopId="desktop-provider-fixture"
        request={request as RemoteRequest}
        onChanged={() => undefined}
        refreshSignal={0}
      />,
    );
  });
  const down = root.root.findAll(
    node => node.props.accessibilityLabel === '下移服务商 Fixture Provider',
  )[0];
  await act(async () => { await down.props.onPress(); });
  expect(request).toHaveBeenCalledWith(
    'desktop-provider-fixture',
    'workspace.provider.order.mutate',
    {folderId: 'tools', providerIds: ['fixture-two', 'fixture']},
    60_000,
  );
  await act(async () => root.unmount());
});

test('disables out-of-range provider arrows and hides sorting controls while searching', async () => {
  const request = jest.fn(async (_desktopId: string, method: string) => {
    if (method === 'workspace.provider.catalog') return catalog;
    return {ok: true};
  });
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ProviderSettings
        desktopId="desktop-provider-fixture"
        request={request as RemoteRequest}
        onChanged={() => undefined}
        refreshSignal={0}
      />,
    );
  });
  expect(root.root.findAll(node => node.props.accessibilityLabel === '上移服务商 Fixture Provider')[0].props.disabled).toBe(true);
  expect(root.root.findAll(node => node.props.accessibilityLabel === '下移服务商 Fixture Provider Two')[0].props.disabled).toBe(true);
  const input = root.root.findAllByType(TextInput).find(node => node.props.placeholder === '搜索服务商');
  await act(async () => input?.props.onChangeText('Fixture'));
  expect(root.root.findAll(node => node.props.accessibilityLabel === '上移服务商 Fixture Provider')[0].props.disabled).toBe(true);
  expect(root.root.findAll(node => node.props.accessibilityLabel === '下移服务商 Fixture Provider')[0].props.disabled).toBe(true);
  await act(async () => root.unmount());
});


test('provider settings keeps secrets private and submits only changed provider fields', async () => {
  const request = jest.fn(async (_desktopId: string, method: string, _params?: Record<string, unknown>) => {
    if (method === 'workspace.provider.catalog') return catalog;
    if (method === 'workspace.provider.get') {
      return {ok: true, provider: catalog.providers[0], options: catalog.options};
    }
    return {ok: true};
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ProviderSettings
        desktopId="desktop-provider-fixture"
        request={request as RemoteRequest}
        onChanged={() => undefined}
        refreshSignal={0}
      />,
    );
  });
  expect(root.root.findAllByType(Text).some(node => node.props.children === '未分类')).toBe(true);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '新建目录')).toBe(true);
  expect(root.root.findAllByType(Text).some(node => node.props.children === '新增服务商')).toBe(true);
  const groupLabels = root.root.findAllByType(Text).map(node => node.props.children).filter(value => value === '工具' || value === '未分类');
  expect(groupLabels).toEqual(['工具', '未分类']);
  const writeCountBeforeCollapse = request.mock.calls.filter(([, method]) => String(method).includes('.mutate')).length;
  await act(async () => press(root, '未分类').props.onPress());
  expect(request.mock.calls.filter(([, method]) => String(method).includes('.mutate')).length).toBe(writeCountBeforeCollapse);


  await act(async () => press(root, 'Fixture Provider').props.onPress());
  const inputs = root.root.findAllByType(TextInput);
  const keyInput = inputs.find(node => node.props.secureTextEntry === true && String(node.props.placeholder || '').includes('Key'));
  expect(keyInput?.props.value).toBe('');
  expect(root.toJSON()).not.toContain('PRIVATE_PROVIDER_KEY');
  const nameInput = inputs.find(node => node.props.placeholder === '服务商名称');
  await act(async () => nameInput?.props.onChangeText('Renamed Provider'));
  await act(async () => press(root, '保存').props.onPress());
  const patchCall = request.mock.calls.find(([, method, params]) =>
    method === 'workspace.provider.mutate' && (params as {operation?: string}).operation === 'patch',
  );
  expect(patchCall?.[2]).toMatchObject({
    id: 'fixture',
    expectedRevision: 'provider-revision-fixture',
    patch: {name: 'Renamed Provider'},
  });
  expect((patchCall?.[2] as {patch: Record<string, unknown>}).patch).not.toHaveProperty('apiKeys');
  expect((patchCall?.[2] as {patch: Record<string, unknown>}).patch).not.toHaveProperty('headerOps');
  alert.mockRestore();
  await act(async () => root.unmount());
});
