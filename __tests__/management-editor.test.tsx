import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, TextInput } from 'react-native';
import { ManagementEditor } from '../src/components/ManagementEditor';
import type { RemoteRequest } from '../src/remote/api';

const item = {
  id: 'provider-fixture',
  revision: 'fixture-revision',
  name: 'Provider',
  url: 'https://example.test',
  hasApiKey: true,
  models: ['model'],
};
test('saves changed fields only with revision; never echoes an existing secret', async () => {
  const rpc = jest.fn(async () => ({ ok: true }));
  const saved = jest.fn();
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ManagementEditor
        desktopId="desktop-fixture"
        section="providers"
        item={item}
        request={rpc as RemoteRequest}
        onClose={() => undefined}
        onSaved={saved}
      />,
    );
  });
  expect(
    root.root.findAllByType(TextInput).find(node => node.props.secureTextEntry)
      ?.props.value,
  ).toBe('');
  await act(async () =>
    root.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === '名称')!
      .props.onChangeText('Renamed'),
  );
  await act(async () =>
    root.root
      .findAll(node => node.props.accessibilityLabel === '保存配置' && typeof node.props.onPress === 'function')[0]
      .props.onPress(),
  );
  expect(rpc).toHaveBeenCalledWith(
    'desktop-fixture',
    'workspace.management.patch',
    {
      section: 'providers',
      id: item.id,
      expectedRevision: item.revision,
      patch: { name: 'Renamed' },
    },
    60_000,
  );
  expect(saved).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
test('secret replacement needs local confirmation before network mutation', async () => {
  const rpc = jest.fn(async () => ({ ok: true }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(
      <ManagementEditor
        desktopId="desktop-fixture"
        section="providers"
        item={item}
        request={rpc as RemoteRequest}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
  });
  await act(async () =>
    root.root
      .findAllByType(TextInput)
      .find(node => node.props.secureTextEntry)!
      .props.onChangeText('synthetic-new-key'),
  );
  await act(async () =>
    root.root
      .findAll(node => node.props.accessibilityLabel === '保存配置' && typeof node.props.onPress === 'function')[0]
      .props.onPress(),
  );
  expect(rpc).not.toHaveBeenCalled();
  await act(async () => {
    await alert.mock.calls[0][2]
      ?.find(button => button.text === '确认替换')
      ?.onPress?.();
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  alert.mockRestore();
});
